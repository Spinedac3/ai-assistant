import { z } from "zod";

// Taken out of the arguments by the registry; the tool never sees it
export const FILTER_PARAM = "filter_rows";

const OPS = [
  "=",
  "!=",
  ">",
  ">=",
  "<",
  "<=",
  "between",
  "contains",
  "in",
  "empty",
  "not_empty",
] as const;
type Op = (typeof OPS)[number];

const isEmpty = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "");

// A condition without the value its operator needs would compare against nothing and quietly
// match no row, which reads as a true zero
const conditionSchema = z
  .object({ field: z.string().min(1), op: z.enum(OPS), value: z.unknown().optional() })
  .strict()
  .refine(
    ({ op, value }) => {
      if (op === "empty" || op === "not_empty") {
        return true;
      }
      if (op === "between") {
        return Array.isArray(value) && value.length === 2 && !value.some(isEmpty);
      }
      if (op === "in") {
        return Array.isArray(value) && value.length > 0;
      }

      return !isEmpty(value) && !Array.isArray(value);
    },
    { message: "between lleva [desde, hasta]; in, una lista; los demás, un valor" },
  );

const filterSchema = z
  .object({
    where: z.array(conditionSchema).optional(),
    count_by: z.array(z.string().min(1)).optional(),
    sum: z.array(z.string().min(1)).optional(),
    list: z.string().min(1).optional(),
  })
  .strict();
export type RowFilter = z.infer<typeof filterSchema>;

// What the model copies when it asks for a filter
export const FILTER_SHAPE =
  '{"where":[{"field":"<columna>","op":"=|!=|>|>=|<|<=|between|contains|in|empty|not_empty",' +
  '"value":<valor; [desde, hasta] con between; lista con in>}],"count_by":["<columna>"],' +
  '"sum":["<columna numérica>"]}';

export type FilterRequest =
  | { filter: null; args: Record<string, unknown> }
  | { filter: RowFilter; args: Record<string, unknown> }
  | { error: string; args: Record<string, unknown> };

/**
 * Takes the row filter out of a call's arguments; the tool gets the rest
 *
 * @param   args  Arguments from the model
 *
 * @return  The filter, if any, and the arguments for the tool
 */
export function takeFilter(args: Record<string, unknown>): FilterRequest {
  if (!(FILTER_PARAM in args)) {
    return { filter: null, args };
  }

  const { [FILTER_PARAM]: raw, ...rest } = args;
  // A parameter missing from the tool's schema reaches it as JSON text
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      // Stays text and fails below with its name
    }
  }

  const parsed = filterSchema.safeParse(value);
  if (parsed.success) {
    return { filter: parsed.data, args: rest };
  }

  const problems = parsed.error.issues.map((issue) => issue.message).join("; ");

  return {
    error: `${FILTER_PARAM} no tiene la forma esperada (${problems}): ${FILTER_SHAPE}`,
    args: rest,
  };
}

interface Normal {
  number: number | null;
  text: string;
}

const isRow = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
// A leading zero marks a code, not a quantity: 0123 and 123 are different employees
const NUMERIC = /^-?(0|[1-9]\d*)(\.\d+)?$/;

/**
 * Reads a value the way every comparison sees it: a number when it is one, and text without
 * accents or case otherwise
 *
 * @param   value  Cell or asked value
 *
 * @return  Its number and its text
 */
function normal(value: unknown): Normal {
  const number =
    typeof value === "number"
      ? value
      : typeof value === "string" && NUMERIC.test(value.trim())
        ? Number(value)
        : null;

  return {
    number,
    text: String(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim(),
  };
}

/**
 * Names a value for equality and grouping, so 7 and "7" or "Bodega" and "bodega" are one
 *
 * @param   value  Normalized value
 * @param   day    Whether only the day of a date counts
 *
 * @return  The key
 */
function keyOf(value: Normal, day = false): string {
  return value.number !== null
    ? `n:${value.number}`
    : `t:${day ? value.text.slice(0, 10) : value.text}`;
}

/**
 * Orders a cell against a value: numbers as numbers, text as text, and a cell with a time
 * against a bare date by its day
 *
 * @param   cell  Normalized cell
 * @param   want  Normalized asked value
 *
 * @return  Negative, zero or positive
 */
function compare(cell: Normal, want: Normal): number {
  if (cell.number !== null && want.number !== null) {
    return cell.number - want.number;
  }

  const found = DATE_ONLY.test(want.text) ? cell.text.slice(0, 10) : cell.text;

  return found < want.text ? -1 : found > want.text ? 1 : 0;
}

/**
 * Turns a condition into a test of one cell, normalizing the asked values once and not per row
 *
 * @param   op     Operator
 * @param   value  Value asked for
 *
 * @return  Whether a normalized cell meets it
 */
function testFor(op: Op, value: unknown): (cell: Normal) => boolean {
  const want = normal(value);
  const values = (Array.isArray(value) ? value : [value]).map(normal);

  switch (op) {
    case "=":
      return (cell) => compare(cell, want) === 0;
    case "!=":
      return (cell) => compare(cell, want) !== 0;
    case ">":
      return (cell) => compare(cell, want) > 0;
    case ">=":
      return (cell) => compare(cell, want) >= 0;
    case "<":
      return (cell) => compare(cell, want) < 0;
    case "<=":
      return (cell) => compare(cell, want) <= 0;
    case "between": {
      const [low, high] = values as [Normal, Normal];
      return (cell) => compare(cell, low) >= 0 && compare(cell, high) <= 0;
    }
    case "contains":
      return (cell) => cell.text.includes(want.text);
    case "in": {
      const keys = new Set(values.map((item) => keyOf(item)));
      const byDay = values.some((item) => DATE_ONLY.test(item.text));
      return (cell) => keys.has(keyOf(cell)) || (byDay && keys.has(keyOf(cell, true)));
    }
    case "empty":
    case "not_empty":
      return () => true;
  }
}

/**
 * Lists the lists of rows in a result, heaviest first; a list of plain values has no columns
 *
 * @param   data  Tool result
 *
 * @return  Their names
 */
function rowLists(data: Record<string, unknown>): string[] {
  return Object.entries(data)
    .filter(([, value]) => Array.isArray(value) && value.every(isRow))
    .map(([name, value]) => ({ name, weight: JSON.stringify(value).length }))
    .sort((a, b) => b.weight - a.weight)
    .map((entry) => entry.name);
}

/**
 * Lists the columns of a list that can be filtered: those holding plain values
 *
 * @param   rows  List
 *
 * @return  Column names in the order they first appear
 */
function columnsOf(rows: readonly Record<string, unknown>[]): string[] {
  const columns = new Set<string>();
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (value === null || typeof value !== "object") {
        columns.add(key);
      }
    }
  }

  return [...columns];
}

/**
 * Names the list of a result and its filterable columns, taken before the cut, when after it no
 * row may be left
 *
 * @param   data  Tool result
 *
 * @return  The list and its columns, or null when there is nothing to filter
 */
export function filterable(
  data: Record<string, unknown>,
): { list: string; columns: string[] } | null {
  const [list] = rowLists(data);
  const columns = list ? columnsOf(data[list] as Record<string, unknown>[]) : [];

  return list && columns.length > 0 ? { list, columns } : null;
}

/**
 * Tells the model, once its result was cut, how to ask for only a part of the list
 *
 * @param   target  List and columns of the uncut result
 *
 * @return  Text added to the cut note
 */
export function filterHint(target: { list: string; columns: string[] }): string {
  return (
    ` EXCEPCIÓN a «no vuelvas a llamar»: si la persona pidió SOLO UNA PARTE de "${target.list}" ` +
    "(por una fecha, un valor, unos códigos, las que tienen un campo vacío) o un conteo por grupo, " +
    "no filtres ni cuentes sobre lo que ves aquí ni respondas «el resto está en el Excel»: llama " +
    `UNA vez más a esta herramienta con los mismos parámetros más ${FILTER_PARAM}: ${FILTER_SHAPE}. ` +
    `El filtro corre sobre TODAS las filas. Columnas: ${target.columns.join(", ")}.`
  );
}

export type Filtered = { ok: true; data: Record<string, unknown> } | { ok: false; message: string };

/**
 * Applies a filter to every row of a result's list, and counts and sums what is left
 *
 * @param   data    Tool result
 * @param   filter  Filter asked for
 *
 * @return  The result with only the matching rows, or why the filter does not apply
 */
export function applyFilter(data: Record<string, unknown>, filter: RowFilter): Filtered {
  const lists = rowLists(data);
  const list = filter.list ?? lists[0];
  if (!list || !lists.includes(list)) {
    return {
      ok: false,
      message:
        lists.length > 0
          ? `"${filter.list}" no es una lista de filas de este resultado; usa una de: ${lists.join(", ")}.`
          : "Este resultado no tiene una lista de filas que filtrar.",
    };
  }

  const rows = data[list] as Record<string, unknown>[];
  const columns = columnsOf(rows);
  const asked = [
    ...(filter.where ?? []).map((condition) => condition.field),
    ...(filter.count_by ?? []),
    ...(filter.sum ?? []),
  ];
  const unknown = [...new Set(asked.filter((column) => !columns.includes(column)))];
  // An empty list has no columns to check, and filtering it leaves it empty
  if (rows.length > 0 && unknown.length > 0) {
    return {
      ok: false,
      message: `"${list}" no tiene la(s) columna(s) ${unknown.join(", ")}. Usa una de: ${columns.join(", ")}.`,
    };
  }

  const conditions = (filter.where ?? []).map((condition) => ({
    ...condition,
    test: testFor(condition.op, condition.value),
  }));
  // Rows without a value in a compared column are counted, so none drops out unseen
  const withoutValue: Record<string, number> = {};
  const left = rows.filter((row) =>
    conditions.every(({ field, op, test }) => {
      const cell = row[field];
      if (op === "empty") {
        return isEmpty(cell);
      }
      if (op === "not_empty") {
        return !isEmpty(cell);
      }
      if (isEmpty(cell)) {
        withoutValue[field] = (withoutValue[field] ?? 0) + 1;
        return false;
      }

      return test(normal(cell));
    }),
  );

  // A value that is not a number is counted, never added as zero to a total that looks complete
  const summed = filter.sum ?? [];
  const notNumeric: Record<string, number> = {};
  const sums = (group: readonly Record<string, unknown>[]) =>
    Object.fromEntries(
      summed.map((column) => {
        let total = 0;
        for (const row of group) {
          const number = isEmpty(row[column]) ? null : normal(row[column]).number;
          if (number !== null) {
            total += number;
          } else if (!isEmpty(row[column]) && group === left) {
            notNumeric[column] = (notNumeric[column] ?? 0) + 1;
          }
        }

        return [column, Math.round(total * 1e6) / 1e6];
      }),
    );
  const totals = sums(left);

  let counts: Record<string, unknown>[] | undefined;
  const countBy = filter.count_by ?? [];
  if (countBy.length > 0) {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of left) {
      const key = JSON.stringify(
        countBy.map((column) => (isEmpty(row[column]) ? null : keyOf(normal(row[column])))),
      );
      const group = groups.get(key);
      if (group) {
        group.push(row);
      } else {
        groups.set(key, [row]);
      }
    }
    // Each group shows the value as its first row wrote it
    counts = [...groups.values()]
      .map((group) => ({
        ...Object.fromEntries(
          countBy.map((column) => [
            column,
            isEmpty(group[0]?.[column]) ? null : group[0]?.[column],
          ]),
        ),
        filas: group.length,
        ...sums(group),
      }))
      .sort((a, b) => b.filas - a.filas);
  }

  const missing = Object.keys(withoutValue).length > 0;
  const odd = Object.keys(notNumeric).length > 0;

  return {
    ok: true,
    data: {
      ...data,
      [list]: left,
      filtro_filas: {
        lista: list,
        filas_antes: rows.length,
        filas_despues: left.length,
        ...(summed.length > 0 ? { sumas: totals } : {}),
        ...(missing ? { sin_dato: withoutValue } : {}),
        ...(odd ? { no_numericas: notNumeric } : {}),
      },
      ...(counts ? { resumen_filtro: counts } : {}),
      nota_filtro:
        `"${list}" quedó filtrada: ${left.length} de ${rows.length} filas. Para contar lo filtrado ` +
        "usa filtro_filas y resumen_filtro; los totales y las otras listas de este resultado son de " +
        "antes del filtro. " +
        (missing
          ? "sin_dato cuenta las filas sin valor en esa columna, que por eso no entraron: dilo. "
          : "") +
        (odd
          ? "no_numericas cuenta celdas que no son número y no se sumaron: la suma no las incluye, dilo. "
          : "") +
        "Dile a la persona con qué condición filtraste.",
    },
  };
}

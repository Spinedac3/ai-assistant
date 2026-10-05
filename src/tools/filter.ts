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

const filterSchema = z
  .object({
    where: z
      .array(
        z
          .object({ field: z.string().min(1), op: z.enum(OPS), value: z.unknown().optional() })
          .strict(),
      )
      .optional(),
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

  return parsed.success
    ? { filter: parsed.data, args: rest }
    : { error: `${FILTER_PARAM} no tiene la forma esperada: ${FILTER_SHAPE}`, args: rest };
}

const isRow = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const isEmpty = (value: unknown): boolean =>
  value === null || value === undefined || (typeof value === "string" && value.trim() === "");
const asText = (value: unknown): string =>
  String(value).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
const asNumber = (value: unknown): number | null =>
  typeof value === "number"
    ? value
    : typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())
      ? Number(value)
      : null;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Orders a cell against a value: numbers as numbers, text without accents or case, and a cell
 * with a time against a bare date by its day
 *
 * @param   cell   Row value
 * @param   value  Value asked for
 *
 * @return  Negative, zero or positive
 */
function compare(cell: unknown, value: unknown): number {
  const left = asNumber(cell);
  const right = asNumber(value);
  if (left !== null && right !== null) {
    return left - right;
  }

  const wanted = asText(value);
  const found = DATE_ONLY.test(wanted) ? asText(cell).slice(0, 10) : asText(cell);

  return found < wanted ? -1 : found > wanted ? 1 : 0;
}

/**
 * Tells whether a cell meets one condition; an empty cell meets none but the emptiness checks
 *
 * @param   cell   Row value
 * @param   op     Operator
 * @param   value  Value asked for
 *
 * @return  Whether it meets it
 */
function meets(cell: unknown, op: Op, value: unknown): boolean {
  if (op === "empty") {
    return isEmpty(cell);
  }
  if (op === "not_empty") {
    return !isEmpty(cell);
  }
  if (isEmpty(cell)) {
    return false;
  }

  const values = Array.isArray(value) ? value : [value];
  switch (op) {
    case "=":
      return compare(cell, value) === 0;
    case "!=":
      return compare(cell, value) !== 0;
    case ">":
      return compare(cell, value) > 0;
    case ">=":
      return compare(cell, value) >= 0;
    case "<":
      return compare(cell, value) < 0;
    case "<=":
      return compare(cell, value) <= 0;
    case "between":
      return compare(cell, values[0]) >= 0 && compare(cell, values[1]) <= 0;
    case "contains":
      return asText(cell).includes(asText(value));
    case "in":
      return values.some((item) => compare(cell, item) === 0);
  }
}

/**
 * Finds the list a filter works on: the one asked for, or the heaviest
 *
 * @param   data   Tool result
 * @param   asked  List named by the model
 *
 * @return  The list name, or null when the result has none
 */
function listOf(data: Record<string, unknown>, asked?: string): string | null {
  if (asked && Array.isArray(data[asked])) {
    return asked;
  }

  const lists = Object.entries(data).filter((entry) => Array.isArray(entry[1]));
  const weight = (value: unknown) => JSON.stringify(value).length;
  lists.sort((a, b) => weight(b[1]) - weight(a[1]));

  return lists[0]?.[0] ?? null;
}

/**
 * Lists the columns of a list that can be filtered: those holding plain values
 *
 * @param   rows  List
 *
 * @return  Column names in the order they first appear
 */
function columnsOf(rows: readonly unknown[]): string[] {
  const columns = new Set<string>();
  for (const row of rows.filter(isRow)) {
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
  const list = listOf(data);
  const columns = list ? columnsOf(data[list] as unknown[]) : [];

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
  const list = listOf(data, filter.list);
  if (!list) {
    return { ok: false, message: "Este resultado no tiene una lista que filtrar." };
  }

  const rows = (data[list] as unknown[]).filter(isRow);
  const columns = columnsOf(rows);
  const asked = [
    ...(filter.where ?? []).map((condition) => condition.field),
    ...(filter.count_by ?? []),
    ...(filter.sum ?? []),
  ];
  const unknown = [...new Set(asked.filter((column) => !columns.includes(column)))];
  if (rows.length > 0 && unknown.length > 0) {
    return {
      ok: false,
      message:
        `"${list}" no tiene la(s) columna(s) ${unknown.join(", ")}. ` +
        `Usa una de: ${columns.join(", ")}.`,
    };
  }

  // Rows without a value in a compared column are counted, so none drops out unseen
  const withoutValue: Record<string, number> = {};
  const left = rows.filter((row) =>
    (filter.where ?? []).every((condition) => {
      if (
        isEmpty(row[condition.field]) &&
        condition.op !== "empty" &&
        condition.op !== "not_empty"
      ) {
        withoutValue[condition.field] = (withoutValue[condition.field] ?? 0) + 1;
      }

      return meets(row[condition.field], condition.op, condition.value);
    }),
  );

  const summed = filter.sum ?? [];
  const sums = (group: readonly Record<string, unknown>[]) =>
    Object.fromEntries(
      summed.map((column) => [
        column,
        Math.round(group.reduce((total, row) => total + (asNumber(row[column]) ?? 0), 0) * 100) /
          100,
      ]),
    );

  let counts: Record<string, unknown>[] | undefined;
  const countBy = filter.count_by ?? [];
  if (countBy.length > 0) {
    const groups = new Map<string, Record<string, unknown>[]>();
    for (const row of left) {
      const key = JSON.stringify(
        countBy.map((column) => (isEmpty(row[column]) ? null : row[column])),
      );
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    counts = [...groups.entries()]
      .map(([key, group]) => ({
        ...Object.fromEntries(
          countBy.map((column, index) => [column, (JSON.parse(key) as unknown[])[index]]),
        ),
        filas: group.length,
        ...sums(group),
      }))
      .sort((a, b) => b.filas - a.filas);
  }

  const noted = Object.keys(withoutValue).length > 0;

  return {
    ok: true,
    data: {
      ...data,
      [list]: left,
      filtro_filas: {
        lista: list,
        filas_antes: rows.length,
        filas_despues: left.length,
        ...(summed.length > 0 ? { sumas: sums(left) } : {}),
        ...(noted ? { sin_dato: withoutValue } : {}),
      },
      ...(counts ? { resumen_filtro: counts } : {}),
      nota_filtro:
        `"${list}" quedó filtrada: ${left.length} de ${rows.length} filas. Para contar lo filtrado ` +
        "usa filtro_filas y resumen_filtro; los totales y las otras listas de este resultado son de " +
        "antes del filtro. " +
        (noted
          ? "sin_dato cuenta las filas sin valor en esa columna, que por eso no entraron: dilo. "
          : "") +
        "Dile a la persona con qué condición filtraste.",
    },
  };
}

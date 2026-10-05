import { Ajv } from "ajv";
import { type ConnectionInfo, type QueryLimits, runQuery } from "../sources/engines.js";
import { normalizeRows } from "./columns.js";
import type { ToolDefinitionSpec } from "./definition.js";
import { buildQuery, paramName, sampleQuery } from "./sql.js";
import { type CreatedTool, outputSchemaOf } from "./tool.js";

type Row = Record<string, unknown>;

export interface CheckResult {
  name: "runs" | "shape" | "filter_shrinks" | "sum_adds_up" | "range_splits";
  ok: boolean;
  // Not applicable to this tool; it passes, and says why it did not run
  skipped?: boolean;
  detail: string;
}

export interface Runner {
  run(spec: ToolDefinitionSpec, args: Record<string, unknown>): Promise<Row[]>;
  sample(columns: string[]): Promise<Row[]>;
}

// Enough rows to find a value for every filter without reading the whole base
const SAMPLE_ROWS = 200;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}/;
const DAY_MS = 86_400_000;

/**
 * Builds the runner of checks over a source: each variant of the definition runs as the tool would
 *
 * @param   info    Connection of the source
 * @param   base    Base of the definition
 * @param   pasted  Checked pasted query, when the base is one
 * @param   limits  Timeout and rows
 *
 * @return  The runner
 */
export function runnerFor(
  info: ConnectionInfo,
  base: ToolDefinitionSpec["base"],
  pasted: string | null,
  limits: QueryLimits,
): Runner {
  return {
    run: async (spec, args) => {
      const query = buildQuery(spec, info.engine, pasted, args);
      return normalizeRows(await runQuery(info, query.sql, query.params, limits));
    },
    sample: async (columns) => {
      const sql = sampleQuery(base, info.engine, pasted, columns, SAMPLE_ROWS);
      return normalizeRows(await runQuery(info, sql, [], limits));
    },
  };
}

/**
 * Picks the value of a filter from the rows of a sample, written as its operator takes it
 *
 * @param   filter  Filter
 * @param   kind    What its column holds
 * @param   rows    Sample rows
 *
 * @return  The argument, or undefined when the sample has no value for it
 */
function sampleArgument(
  filter: ToolDefinitionSpec["filters"][number],
  kind: string,
  rows: Row[],
): unknown {
  const values = rows
    .map((row) => row[filter.column])
    .filter((value) => value !== null && value !== undefined && value !== "");
  const first = values[0];
  if (filter.op === "empty") {
    return false;
  }
  if (first === undefined) {
    return undefined;
  }

  // A date is asked for by its day, the way a person asks
  const plain = (value: unknown) =>
    (kind === "date" || kind === "datetime") && typeof value === "string"
      ? value.slice(0, 10)
      : value;
  switch (filter.op) {
    case "between": {
      const sorted = values.map(plain).sort((a, b) => (String(a) < String(b) ? -1 : 1));
      return kind === "number"
        ? [Math.min(...(values as number[])), Math.max(...(values as number[]))]
        : [sorted[0], sorted[sorted.length - 1]];
    }
    case "in":
      return [plain(first)];
    case "contains": {
      const text = String(first);
      return text.length > 0 ? text.slice(0, Math.min(3, text.length)) : undefined;
    }
    default:
      return plain(first);
  }
}

/**
 * Counts the rows of a list by their content, to compare lists as bags
 *
 * @param   rows  Rows
 *
 * @return  How many times each row appears
 */
function bag(rows: Row[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const key = JSON.stringify(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  return counts;
}

/**
 * Moves a day forward or back
 *
 * @param   day   Date as YYYY-MM-DD
 * @param   days  Days to add
 *
 * @return  The new date as YYYY-MM-DD
 */
function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Runs the automatic checks of a tool: that it runs, that its result has its declared shape, and
 * three properties that hold for any correct query whatever the data, so a check needs no
 * expected answer: a filter only removes rows, the sums of the groups add up to the total, and a
 * range split in two halves holds the rows of the whole
 *
 * @param   tool    Created tool
 * @param   runner  Runs variants of the definition and reads samples
 *
 * @return  One result per check
 */
export async function runChecks(tool: CreatedTool, runner: Runner): Promise<CheckResult[]> {
  const { spec } = tool;
  const kinds = new Map(tool.columns.map((column) => [column.name, column.kind]));
  const filterColumns = [...new Set(spec.filters.map((filter) => filter.column))];
  const sample = filterColumns.length > 0 ? await runner.sample(filterColumns) : [];
  const values = new Map(
    spec.filters.map((filter) => [
      filter.column,
      sampleArgument(filter, kinds.get(filter.column) ?? "text", sample),
    ]),
  );

  const missing = spec.filters.filter((f) => f.required && values.get(f.column) === undefined);
  if (missing.length > 0) {
    return [
      {
        name: "runs",
        ok: false,
        detail: `No hay datos para probar los filtros obligatorios: ${missing.map((f) => f.column).join(", ")}`,
      },
    ];
  }
  const base = Object.fromEntries(
    spec.filters
      .filter((filter) => filter.required)
      .map((filter) => [paramName(filter.column), values.get(filter.column)]),
  );

  const results: CheckResult[] = [];
  let rows: Row[];
  try {
    rows = await runner.run(spec, base);
    results.push({ name: "runs", ok: true, detail: `Corrió con ${rows.length} filas` });
  } catch (error) {
    return [{ name: "runs", ok: false, detail: `No corrió: ${(error as Error).message}` }];
  }

  const validate = new Ajv({ strict: false }).compile(outputSchemaOf(tool));
  const shaped = validate({ filas: rows, total_filas: rows.length });
  results.push({
    name: "shape",
    ok: shaped,
    detail: shaped ? "La salida tiene la forma declarada" : new Ajv().errorsText(validate.errors),
  });

  // The properties are checked on the plain rows, before any summary
  const detail: ToolDefinitionSpec = {
    ...spec,
    columns: tool.columns.map((column) => ({ name: column.name })),
    summary: undefined,
    order_by: [],
  };

  results.push(await filterShrinks(detail, runner, base, values));
  results.push(await sumAddsUp(spec, runner, base));
  results.push(await rangeSplits(detail, runner, base, values));

  return results;
}

/**
 * Checks that each optional filter only removes rows from the result without it
 *
 * @param   detail  Definition without summary
 * @param   runner  Runner
 * @param   base    Arguments of the required filters
 * @param   values  Sample value of each filter
 *
 * @return  The result
 */
async function filterShrinks(
  detail: ToolDefinitionSpec,
  runner: Runner,
  base: Record<string, unknown>,
  values: Map<string, unknown>,
): Promise<CheckResult> {
  const optional = detail.filters.filter((f) => !f.required && values.get(f.column) !== undefined);
  if (optional.length === 0) {
    return {
      name: "filter_shrinks",
      ok: true,
      skipped: true,
      detail: "No hay filtros opcionales con datos para probar",
    };
  }

  const all = bag(await runner.run(detail, base));
  const grown: string[] = [];
  for (const filter of optional) {
    const filtered = bag(
      await runner.run(detail, { ...base, [paramName(filter.column)]: values.get(filter.column) }),
    );
    if ([...filtered].some(([row, times]) => times > (all.get(row) ?? 0))) {
      grown.push(filter.column);
    }
  }

  return {
    name: "filter_shrinks",
    ok: grown.length === 0,
    detail:
      grown.length === 0
        ? `Cada filtro solo quitó filas (${optional.length} probados)`
        : `Al filtrar por ${grown.join(", ")} aparecieron filas que sin el filtro no estaban`,
  };
}

/**
 * Checks that the sums and counts of the groups add up to the same aggregates over every row
 *
 * @param   spec    Definition
 * @param   runner  Runner
 * @param   base    Arguments of the required filters
 *
 * @return  The result
 */
async function sumAddsUp(
  spec: ToolDefinitionSpec,
  runner: Runner,
  base: Record<string, unknown>,
): Promise<CheckResult> {
  const summary = spec.summary;
  const summed = (summary?.aggregates ?? []).filter((a) => a.fn === "sum" || a.fn === "count");
  if (!summary || summary.group_by.length === 0 || summed.length === 0 || !spec.meaning.additive) {
    return {
      name: "sum_adds_up",
      ok: true,
      skipped: true,
      detail: "No agrupa sumas ni conteos que se puedan sumar",
    };
  }

  const grouped = await runner.run(spec, base);
  const [total] = await runner.run(
    { ...spec, summary: { ...summary, group_by: [] }, order_by: [] },
    base,
  );
  const off = summed.filter((aggregate) => {
    const parts = grouped.reduce((sum, row) => sum + Number(row[aggregate.as] ?? 0), 0);
    const whole = Number(total?.[aggregate.as] ?? 0);
    return Math.abs(parts - whole) > 1e-6 * Math.max(1, Math.abs(whole));
  });

  return {
    name: "sum_adds_up",
    ok: off.length === 0,
    detail:
      off.length === 0
        ? "Las sumas por grupo dan el total"
        : `Las sumas por grupo no dan el total en ${off.map((a) => a.as).join(", ")}`,
  };
}

/**
 * Checks that a range split in two halves holds the same rows as the whole range
 *
 * @param   detail  Definition without summary
 * @param   runner  Runner
 * @param   base    Arguments of the required filters
 * @param   values  Sample value of each filter
 *
 * @return  The result
 */
async function rangeSplits(
  detail: ToolDefinitionSpec,
  runner: Runner,
  base: Record<string, unknown>,
  values: Map<string, unknown>,
): Promise<CheckResult> {
  // Halves that meet without overlap are only exact on days and whole numbers
  const range = detail.filters.find((filter) => {
    const value = values.get(filter.column) as [unknown, unknown] | undefined;
    return (
      filter.op === "between" &&
      value !== undefined &&
      value[0] !== value[1] &&
      (DATE_ONLY.test(String(value[0])) ||
        (Number.isInteger(value[0]) && Number.isInteger(value[1])))
    );
  });
  if (!range) {
    return {
      name: "range_splits",
      ok: true,
      skipped: true,
      detail: "No hay un rango de fechas o enteros para partir",
    };
  }

  const [low, high] = values.get(range.column) as [string | number, string | number];
  const days = typeof low === "string";
  const middle = days
    ? addDays(low, Math.floor((Date.parse(String(high)) - Date.parse(low)) / DAY_MS / 2))
    : Math.floor(((low as number) + (high as number)) / 2);
  const after = days ? addDays(String(middle), 1) : (middle as number) + 1;
  const name = paramName(range.column);
  const count = async (from: unknown, to: unknown) =>
    (await runner.run(detail, { ...base, [name]: [from, to] })).length;
  const whole = await count(low, high);
  const halves = (await count(low, middle)) + (await count(after, high));

  return {
    name: "range_splits",
    ok: whole === halves,
    detail:
      whole === halves
        ? `${range.column}: ${low}–${middle} y ${after}–${high} suman las ${whole} filas del rango entero`
        : `${range.column}: las mitades suman ${halves} filas y el rango entero tiene ${whole}`,
  };
}

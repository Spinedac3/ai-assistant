import { Ajv } from "ajv";
import {
  type ColumnKind,
  type ConnectionInfo,
  type QueryLimits,
  runQuery,
} from "../sources/engines.js";
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
  // Rows with a value in every one of the columns
  sample(columns: string[]): Promise<Row[]>;
}

// Enough values to find one for every filter without reading the whole base
const SAMPLE_ROWS = 50;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

/**
 * Builds the runner of checks over a source: each variant of the definition runs as the tool would
 *
 * @param   info    Connection of the source
 * @param   base    Base of the definition
 * @param   pasted  Checked pasted query, when the base is one
 * @param   limits  Timeout and rows
 * @param   kinds   What each column of the base holds
 *
 * @return  The runner
 */
export function runnerFor(
  info: ConnectionInfo,
  base: ToolDefinitionSpec["base"],
  pasted: string | null,
  limits: QueryLimits,
  kinds: ReadonlyMap<string, ColumnKind>,
): Runner {
  return {
    run: async (spec, args) => {
      const query = buildQuery(spec, info.engine, pasted, args, kinds);
      return normalizeRows(await runQuery(info, query.sql, query.params, limits));
    },
    sample: async (columns) => {
      const sql = sampleQuery(base, info.engine, pasted, columns, SAMPLE_ROWS);
      return normalizeRows(await runQuery(info, sql, [], limits));
    },
  };
}

/**
 * Picks the value of a filter from sample values, written as its operator takes it
 *
 * @param   op      Operator
 * @param   kind    What its column holds
 * @param   values  Sample values, none empty
 *
 * @return  The argument, or undefined when there is no value to try
 */
function sampleArgument(op: string, kind: ColumnKind, values: unknown[]): unknown {
  if (op === "empty") {
    return false;
  }
  const dated = kind === "date" || kind === "datetime";
  // A date is asked for by its day, the way a person asks
  const plain = values.map((value) =>
    dated && typeof value === "string" ? value.slice(0, 10) : value,
  );
  const first = plain[0];
  if (first === undefined) {
    return undefined;
  }

  switch (op) {
    case "between": {
      const sorted = [...plain].sort((a, b) =>
        kind === "number" ? Number(a) - Number(b) : String(a) < String(b) ? -1 : 1,
      );
      return [sorted[0], sorted[sorted.length - 1]];
    }
    case "in":
      return [first];
    case "contains": {
      const text = String(first);
      return text.length > 0 ? text.slice(0, Math.min(3, text.length)) : undefined;
    }
    default:
      return first;
  }
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
 * Runs a check, turning any failure of the source into a failed check with its reason
 *
 * @param   name  Check
 * @param   work  The check itself
 *
 * @return  Its result
 */
async function guarded(
  name: CheckResult["name"],
  work: () => Promise<CheckResult>,
): Promise<CheckResult> {
  try {
    return await work();
  } catch (error) {
    return { name, ok: false, detail: `No se pudo probar: ${(error as Error).message}` };
  }
}

/**
 * Runs the automatic checks of a tool: that it runs, that its result has its declared shape, and
 * three properties that hold for any correct query whatever the data, so a check needs no
 * expected answer: a filter only removes rows, the sums of the groups add up to the total, and the
 * two halves of a range hold the rows of the whole
 *
 * They compare counts and sums the source computes, so a base of any size is checked without
 * bringing its rows over.
 *
 * @param   tool    Created tool
 * @param   runner  Runs variants of the definition and reads samples
 *
 * @return  One result per check
 */
export async function runChecks(tool: CreatedTool, runner: Runner): Promise<CheckResult[]> {
  const { spec } = tool;
  const kinds = new Map(tool.columns.map((column) => [column.name, column.kind]));

  const values = new Map<string, unknown>();
  const valuesOf = (rows: Row[], column: string) =>
    rows.map((row) => row[column]).filter((value) => value !== null && value !== "");
  try {
    // The required filters take their values from one same row, so together they match it
    const required = spec.filters.filter((filter) => filter.required);
    const together =
      required.length > 0
        ? (await runner.sample(required.map((filter) => filter.column))).slice(0, 1)
        : [];
    for (const filter of spec.filters) {
      const kind = kinds.get(filter.column) ?? "text";
      const rows = filter.required ? together : await runner.sample([filter.column]);
      values.set(filter.column, sampleArgument(filter.op, kind, valuesOf(rows, filter.column)));
    }
  } catch (error) {
    return [
      { name: "runs", ok: false, detail: `No se pudo leer la base: ${(error as Error).message}` },
    ];
  }

  const missing = spec.filters.filter((f) => f.required && values.get(f.column) === undefined);
  if (missing.length > 0) {
    return [
      {
        name: "runs",
        ok: false,
        detail: `La base no tiene datos para probar los filtros obligatorios: ${missing.map((f) => f.column).join(", ")}`,
      },
    ];
  }
  const base = Object.fromEntries(
    spec.filters
      .filter((filter) => filter.required)
      .map((filter) => [paramName(filter.column), values.get(filter.column)]),
  );

  // Counting runs on the plain rows, before any summary
  const counted: ToolDefinitionSpec = {
    ...spec,
    summary: { group_by: [], aggregates: [{ fn: "count", as: "filas" }] },
    order_by: [],
  };
  const count = async (args: Record<string, unknown>) =>
    Number((await runner.run(counted, args))[0]?.filas ?? 0);

  let rows: Row[];
  try {
    rows = await runner.run(spec, base);
    // A tool over no rows passes every property and proves nothing
    if ((await count(base)) === 0) {
      return [
        {
          name: "runs",
          ok: false,
          detail:
            Object.keys(base).length > 0
              ? "No hay filas con los valores de prueba de los filtros obligatorios"
              : "La base no tiene filas con que probar la herramienta",
        },
      ];
    }
  } catch (error) {
    return [{ name: "runs", ok: false, detail: `No corrió: ${(error as Error).message}` }];
  }

  const validate = new Ajv({ strict: false }).compile(outputSchemaOf(tool));
  const shaped = validate({ filas: rows, total_filas: rows.length });

  return [
    { name: "runs", ok: true, detail: `Corrió con ${rows.length} filas` },
    {
      name: "shape",
      ok: shaped,
      detail: shaped ? "La salida tiene la forma declarada" : new Ajv().errorsText(validate.errors),
    },
    await guarded("filter_shrinks", () => filterShrinks(spec, count, base, values)),
    await guarded("sum_adds_up", () => sumAddsUp(spec, runner, base)),
    await guarded("range_splits", () => rangeSplits(spec, count, base, kinds, values)),
  ];
}

/**
 * Checks that each optional filter only removes rows from the result without it
 *
 * @param   spec    Definition
 * @param   count   Counts the rows of a call
 * @param   base    Arguments of the required filters
 * @param   values  Sample value of each filter
 *
 * @return  The result
 */
async function filterShrinks(
  spec: ToolDefinitionSpec,
  count: (args: Record<string, unknown>) => Promise<number>,
  base: Record<string, unknown>,
  values: Map<string, unknown>,
): Promise<CheckResult> {
  const optional = spec.filters.filter((f) => !f.required && values.get(f.column) !== undefined);
  if (optional.length === 0) {
    return {
      name: "filter_shrinks",
      ok: true,
      skipped: true,
      detail: "No hay filtros opcionales con datos para probar",
    };
  }

  const all = await count(base);
  const grown: string[] = [];
  for (const filter of optional) {
    const filtered = await count({
      ...base,
      [paramName(filter.column)]: values.get(filter.column),
    });
    if (filtered > all) {
      grown.push(filter.column);
    }
  }

  return {
    name: "filter_shrinks",
    ok: grown.length === 0,
    detail:
      grown.length === 0
        ? `Cada filtro solo quitó filas (${optional.length} probados)`
        : `Al filtrar por ${grown.join(", ")} hubo más filas que sin el filtro`,
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
 * Checks that two halves of a range hold the rows of the whole range
 *
 * Days split into halves that meet without overlap, which also catches a source that drops the
 * last day of every range. Numbers may have decimals between any two, so their halves share the
 * middle and it is counted once.
 *
 * @param   spec    Definition
 * @param   count   Counts the rows of a call
 * @param   base    Arguments of the required filters
 * @param   kinds   What each column holds
 * @param   values  Sample value of each filter
 *
 * @return  The result
 */
async function rangeSplits(
  spec: ToolDefinitionSpec,
  count: (args: Record<string, unknown>) => Promise<number>,
  base: Record<string, unknown>,
  kinds: Map<string, ColumnKind>,
  values: Map<string, unknown>,
): Promise<CheckResult> {
  const range = spec.filters.find((filter) => {
    const kind = kinds.get(filter.column);
    const value = values.get(filter.column) as [unknown, unknown] | undefined;
    return (
      filter.op === "between" &&
      (kind === "number" || kind === "date" || kind === "datetime") &&
      value !== undefined &&
      value[0] !== value[1]
    );
  });
  if (!range) {
    return {
      name: "range_splits",
      ok: true,
      skipped: true,
      detail: "No hay un rango de números o fechas para partir",
    };
  }

  const [low, high] = values.get(range.column) as [string | number, string | number];
  const days = typeof low === "string" && DATE_ONLY.test(low);
  const middle = days
    ? addDays(low, Math.floor((Date.parse(String(high)) - Date.parse(low)) / DAY_MS / 2))
    : // Whole numbers split on a whole number, which an integer column takes as a parameter
      Number.isInteger(low) && Number.isInteger(high)
      ? Math.floor(((low as number) + (high as number)) / 2)
      : ((low as number) + (high as number)) / 2;
  const name = paramName(range.column);
  const span = (from: unknown, to: unknown) => count({ ...base, [name]: [from, to] });
  const whole = await span(low, high);
  const next = days ? addDays(String(middle), 1) : middle;
  const halves =
    (await span(low, middle)) + (await span(next, high)) - (days ? 0 : await span(middle, middle));

  return {
    name: "range_splits",
    ok: whole === halves,
    detail:
      whole === halves
        ? `${range.column}: ${low}–${middle} y ${next}–${high} suman las ${whole} filas del rango entero`
        : `${range.column}: las mitades suman ${halves} filas y el rango entero tiene ${whole}`,
  };
}

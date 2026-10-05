import { describe, expect, it } from "vitest";
import { type Runner, runChecks } from "../../src/creator/checks.js";
import { definitionSchema, type ToolDefinitionSpec } from "../../src/creator/definition.js";
import type { CreatedTool } from "../../src/creator/tool.js";

type Row = Record<string, unknown>;
type Fault = "extra_row" | "lost_group" | "last_day_excluded" | "throws_on_groups";

const rows: Row[] = [
  { ruta: "R-Norte-1", dia: "2026-03-01", cantidad: 2.5 },
  // On the day where a range of the whole month splits in two
  { ruta: "R-Norte-1", dia: "2026-03-16", cantidad: 3 },
  { ruta: "R-Sur-1", dia: "2026-03-20", cantidad: 5.25 },
  { ruta: "R-Sur-2", dia: "2026-03-31", cantidad: 7 },
];

const tool: CreatedTool = {
  name: "entregas_por_ruta",
  sourceCode: "demo",
  columns: [
    { name: "ruta", kind: "text" },
    { name: "dia", kind: "date" },
    { name: "cantidad", kind: "number" },
  ],
  spec: definitionSchema.parse({
    base: { kind: "table", name: "entregas" },
    columns: [{ name: "ruta" }, { name: "dia" }, { name: "cantidad" }],
    filters: [
      { column: "ruta", op: "=" },
      { column: "dia", op: "between" },
    ],
    summary: {
      group_by: ["ruta"],
      aggregates: [
        { fn: "sum", column: "cantidad", as: "total" },
        { fn: "count", as: "entregas" },
      ],
    },
    meaning: { definition: "Entregas", grain: "ruta", additive: true },
  }),
};

/**
 * Runs a definition over rows in memory, as a source would, optionally with one fault
 *
 * @param   spec   Definition
 * @param   args   Filter values
 * @param   data   Rows of the base
 * @param   fault  What the source gets wrong
 *
 * @return  The rows of the result
 */
function evaluate(
  spec: ToolDefinitionSpec,
  args: Record<string, unknown>,
  data: Row[],
  fault?: Fault,
): Row[] {
  let kept = data.filter((row) => {
    if (args.ruta !== undefined && row.ruta !== args.ruta) {
      return false;
    }
    const range = args.dia as [string, string] | undefined;
    if (!range) {
      return true;
    }
    const day = String(row.dia);
    // The classic off-by-one: a range that ends before its last day
    const last = fault === "last_day_excluded" ? day < range[1] : day <= range[1];
    return day >= range[0] && last;
  });
  if (fault === "extra_row" && args.ruta !== undefined) {
    kept = [...kept, { ruta: "R-Fantasma", dia: "2026-03-05", cantidad: 1 }, ...data];
  }

  const summary = spec.summary;
  if (!summary) {
    return kept;
  }
  if (fault === "throws_on_groups" && summary.group_by.length > 0) {
    throw new Error("timeout de la fuente");
  }

  const groups = new Map<string, Row[]>();
  for (const row of kept) {
    const key = summary.group_by.map((column) => String(row[column])).join("|");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  if (groups.size === 0 && summary.group_by.length === 0) {
    groups.set("", []);
  }
  const result = [...groups.values()].map((group) => ({
    ...Object.fromEntries(summary.group_by.map((column) => [column, group[0]?.[column]])),
    ...Object.fromEntries(
      summary.aggregates.map((aggregate) => [
        aggregate.as,
        aggregate.fn === "count"
          ? group.length
          : group.reduce((sum, row) => sum + Number(row[aggregate.column ?? ""]), 0),
      ]),
    ),
  }));

  return fault === "lost_group" && summary.group_by.length > 0 ? result.slice(1) : result;
}

/**
 * Builds a runner over rows in memory
 *
 * @param   fault  What the source gets wrong
 * @param   data   Rows of the base
 *
 * @return  The runner
 */
function runner(fault?: Fault, data = rows): Runner {
  return {
    sample: async (columns) => data.filter((row) => columns.every((column) => row[column] != null)),
    run: async (spec, args) => evaluate(spec, args, data, fault),
  };
}

/**
 * Lists the checks that failed
 *
 * @param   checked  Tool to check
 * @param   source   Runner
 *
 * @return  Their names
 */
async function failed(checked: CreatedTool, source: Runner): Promise<string[]> {
  return (await runChecks(checked, source)).filter((result) => !result.ok).map((r) => r.name);
}

describe("tool checks", () => {
  it("passes a correct tool on every check", async () => {
    // Performs the test.
    const results = await runChecks(tool, runner());

    // Performs assertions.
    expect(results.map((result) => [result.name, result.ok, result.skipped ?? false])).toEqual([
      ["runs", true, false],
      ["shape", true, false],
      ["filter_shrinks", true, false],
      ["sum_adds_up", true, false],
      ["range_splits", true, false],
    ]);
  });

  it("catches a filter that adds rows, groups that lose a total and a range that loses its last day", async () => {
    // Performs assertions.
    expect(await failed(tool, runner("extra_row"))).toEqual(["filter_shrinks"]);
    expect(await failed(tool, runner("lost_group"))).toEqual(["sum_adds_up"]);
    expect(await failed(tool, runner("last_day_excluded"))).toEqual(["range_splits"]);
  });

  it("splits a range of decimals without losing what lies between two whole numbers", async () => {
    // Performs the test.
    const decimals: CreatedTool = {
      ...tool,
      spec: { ...tool.spec, filters: [{ column: "cantidad", op: "between", required: false }] },
    };
    // One row sits exactly on the middle of 2.5 and 7, which both halves hold
    const data = [...rows, { ruta: "R-Centro-1", dia: "2026-03-12", cantidad: 4.75 }];
    const source: Runner = {
      sample: async () => data,
      run: async (spec, args) => {
        const range = args.cantidad as [number, number] | undefined;
        const kept = range
          ? data.filter(
              (row) => Number(row.cantidad) >= range[0] && Number(row.cantidad) <= range[1],
            )
          : data;
        return evaluate(spec, {}, kept);
      },
    };
    const results = await runChecks(decimals, source);

    // Performs assertions.
    const range = results.find((result) => result.name === "range_splits");
    expect(range?.ok).toBe(true);
    expect(range?.skipped).toBeUndefined();
  });

  it("turns a failing check into a failed result instead of an error", async () => {
    // Performs the test.
    const results = await runChecks(
      { ...tool, spec: { ...tool.spec, filters: [] } },
      {
        sample: async () => [],
        run: async (spec, args) =>
          spec.summary?.aggregates.some((aggregate) => aggregate.as === "total")
            ? evaluate(spec, args, rows, "throws_on_groups")
            : evaluate(spec, args, rows),
      },
    );

    // Performs assertions.
    expect(results.find((result) => result.name === "runs")?.ok).toBe(false);
    expect(String(results[0]?.detail)).toContain("timeout de la fuente");
  });

  it("catches a result outside its declared shape and a tool that does not run", async () => {
    // Performs the test.
    const misshaped = await runChecks(tool, {
      sample: async () => rows,
      run: async (spec, args) =>
        spec.summary?.aggregates.some((aggregate) => aggregate.as === "filas")
          ? evaluate(spec, args, rows)
          : [{ ruta: 5, total: "mucho", entregas: 1 }],
    });
    const failing = await runChecks(tool, {
      sample: async () => {
        throw new Error("relation entregas does not exist");
      },
      run: async () => [],
    });

    // Performs assertions.
    expect(misshaped.find((result) => result.name === "shape")?.ok).toBe(false);
    expect(failing).toEqual([
      {
        name: "runs",
        ok: false,
        detail: "No se pudo leer la base: relation entregas does not exist",
      },
    ]);
  });

  it("refuses a base with no rows, and a required filter with no data, as proving nothing", async () => {
    // Performs the test.
    const empty = await runChecks(tool, runner(undefined, []));
    const required: CreatedTool = {
      ...tool,
      spec: { ...tool.spec, filters: [{ column: "ruta", op: "=", required: true }] },
    };
    const noData = await runChecks(required, { sample: async () => [], run: async () => [] });

    // Performs assertions.
    expect(empty).toEqual([
      { name: "runs", ok: false, detail: "La base no tiene filas con que probar la herramienta" },
    ]);
    expect(noData[0]).toMatchObject({ name: "runs", ok: false });
  });

  it("skips what does not apply", async () => {
    // Performs the test.
    const plain: CreatedTool = { ...tool, spec: { ...tool.spec, filters: [], summary: undefined } };
    const results = await runChecks(plain, runner());

    // Performs assertions.
    expect(results.filter((result) => result.skipped).map((result) => result.name)).toEqual([
      "filter_shrinks",
      "sum_adds_up",
      "range_splits",
    ]);
  });

  it("takes the values of the required filters from one same row", async () => {
    // Performs the test.
    const required: CreatedTool = {
      ...tool,
      spec: {
        ...tool.spec,
        filters: [
          { column: "ruta", op: "=", required: true },
          { column: "dia", op: "=", required: true },
        ],
      },
    };
    const asked: Record<string, unknown>[] = [];
    const results = await runChecks(required, {
      sample: async (columns) =>
        columns.length > 1
          ? [rows[2] as Row]
          : // Per column, the first value of each would come from different rows
            rows.map((row) => ({ [columns[0] as string]: row[columns[0] as string] })),
      run: async (spec, args) => {
        asked.push(args);
        return evaluate(
          spec,
          { ruta: args.ruta },
          rows.filter((row) => row.dia === args.dia),
        );
      },
    });

    // Performs assertions.
    expect(asked[0]).toEqual({ ruta: "R-Sur-1", dia: "2026-03-20" });
    expect(results[0]).toMatchObject({ name: "runs", ok: true });
  });

  it("splits a range of whole numbers on a whole number", async () => {
    // Performs the test.
    const whole: CreatedTool = {
      ...tool,
      columns: [...tool.columns.slice(0, 2), { name: "cantidad", kind: "number" }],
      spec: { ...tool.spec, filters: [{ column: "cantidad", op: "between", required: false }] },
    };
    const data = [
      { ruta: "A", dia: "2026-03-01", cantidad: 3 },
      { ruta: "B", dia: "2026-03-02", cantidad: 4 },
      { ruta: "C", dia: "2026-03-03", cantidad: 6 },
    ];
    const bounds: unknown[] = [];
    await runChecks(whole, {
      sample: async () => data,
      run: async (spec, args) => {
        const range = args.cantidad as [number, number] | undefined;
        if (range) {
          bounds.push(...range);
        }
        const kept = range
          ? data.filter((row) => row.cantidad >= range[0] && row.cantidad <= range[1])
          : data;
        return evaluate(spec, {}, kept);
      },
    });

    // Performs assertions.
    expect(bounds.every((bound) => Number.isInteger(bound))).toBe(true);
  });
});

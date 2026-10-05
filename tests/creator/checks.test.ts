import { describe, expect, it } from "vitest";
import { type Runner, runChecks } from "../../src/creator/checks.js";
import { definitionSchema, type ToolDefinitionSpec } from "../../src/creator/definition.js";
import type { CreatedTool } from "../../src/creator/tool.js";

type Row = Record<string, unknown>;

const rows: Row[] = [
  { ruta: "R-Norte-1", dia: "2026-03-01", cantidad: 2 },
  // On the day where a range of the whole month splits in two
  { ruta: "R-Norte-1", dia: "2026-03-16", cantidad: 3 },
  { ruta: "R-Sur-1", dia: "2026-03-20", cantidad: 5 },
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
 * Runs a definition over the test rows in memory, as a correct source would
 *
 * @param   spec  Definition
 * @param   args  Filter values
 *
 * @return  The rows
 */
function honest(spec: ToolDefinitionSpec, args: Record<string, unknown>): Row[] {
  const kept = rows.filter((row) => {
    if (args.ruta !== undefined && row.ruta !== args.ruta) {
      return false;
    }
    const range = args.dia as [string, string] | undefined;
    return !range || (String(row.dia) >= range[0] && String(row.dia) <= range[1]);
  });
  const summary = spec.summary;
  if (!summary) {
    return kept;
  }

  const groups = new Map<string, Row[]>();
  for (const row of kept) {
    const key = summary.group_by.map((column) => String(row[column])).join("|");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }

  return [...groups.values()].map((group) => ({
    ...Object.fromEntries(summary.group_by.map((column) => [column, group[0]?.[column]])),
    total: group.reduce((sum, row) => sum + Number(row.cantidad), 0),
    entregas: group.length,
  }));
}

/**
 * Builds a runner over the test rows, optionally broken in one way
 *
 * @param   broken  What the source gets wrong
 *
 * @return  The runner
 */
function runner(broken?: "extra_row" | "lost_group" | "lost_day"): Runner {
  return {
    sample: async () => rows,
    run: async (spec, args) => {
      let found = honest(spec, args);
      if (broken === "extra_row" && args.ruta !== undefined && !spec.summary) {
        found = [...found, { ruta: "R-Fantasma", dia: "2026-03-05", cantidad: 1 }];
      }
      if (broken === "lost_group" && spec.summary?.group_by.length) {
        found = found.slice(1);
      }
      // A day's rows lost at the edge of a range, as a filter on midnight would lose them
      const range = args.dia as [string, string] | undefined;
      if (broken === "lost_day" && range && range[1] !== "2026-03-31") {
        found = found.filter((row) => row.dia !== range[1]);
      }
      return found;
    },
  };
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

  it("catches a filter that adds rows, groups that lose a total and a range that loses a day", async () => {
    // Performs the test.
    const failed = async (broken: Parameters<typeof runner>[0]) =>
      (await runChecks(tool, runner(broken))).filter((result) => !result.ok).map((r) => r.name);

    // Performs assertions.
    expect(await failed("extra_row")).toEqual(["filter_shrinks"]);
    expect(await failed("lost_group")).toEqual(["sum_adds_up"]);
    expect(await failed("lost_day")).toEqual(["range_splits"]);
  });

  it("catches a result outside its declared shape and a tool that does not run", async () => {
    // Performs the test.
    const misshaped = await runChecks(tool, {
      sample: async () => rows,
      run: async () => [{ ruta: 5, total: "mucho", entregas: 1 }],
    });
    const failing = await runChecks(tool, {
      sample: async () => rows,
      run: async () => {
        throw new Error("relation entregas does not exist");
      },
    });

    // Performs assertions.
    expect(misshaped.find((result) => result.name === "shape")?.ok).toBe(false);
    expect(failing).toEqual([
      { name: "runs", ok: false, detail: "No corrió: relation entregas does not exist" },
    ]);
  });

  it("skips what does not apply, and stops when a required filter has no data to try", async () => {
    // Performs the test.
    const plain: CreatedTool = {
      ...tool,
      spec: { ...tool.spec, filters: [], summary: undefined },
    };
    const skipped = await runChecks(plain, runner());
    const required: CreatedTool = {
      ...tool,
      spec: { ...tool.spec, filters: [{ column: "ruta", op: "=", required: true }] },
    };
    const empty = await runChecks(required, { sample: async () => [], run: async () => [] });

    // Performs assertions.
    expect(skipped.filter((result) => result.skipped).map((result) => result.name)).toEqual([
      "filter_shrinks",
      "sum_adds_up",
      "range_splits",
    ]);
    expect(empty[0]).toMatchObject({ name: "runs", ok: false });
  });
});

import { describe, expect, it } from "vitest";
import {
  argument,
  blankDefinition,
  cleanDefinition,
  type Definition,
  outputNames,
  prune,
  withDefaults,
} from "./types";

describe("tool definitions in the form", () => {
  it("names the result's columns: the grouped ones and the totals, or the chosen ones", () => {
    // Performs the test.
    const plain = { ...blankDefinition(), columns: [{ name: "ruta" }, { name: "total" }] };
    const summed: Definition = {
      ...plain,
      summary: { group_by: ["ruta"], aggregates: [{ fn: "sum", column: "total", as: "vendido" }] },
    };

    // Performs assertions.
    expect(outputNames(plain)).toEqual(["ruta", "total"]);
    expect(outputNames(summed)).toEqual(["ruta", "vendido"]);
  });

  it("saves without the empty texts a person leaves while typing, and reads back what the server left out", () => {
    // Performs the test.
    const typed: Definition = {
      ...blankDefinition(),
      columns: [
        { name: "ruta", label: "  " },
        { name: "piloto", label: " Piloto " },
      ],
      filters: [{ column: "ruta", op: "in", required: false, description: "" }],
      meaning: {
        definition: "Entregas",
        grain: "entrega",
        additive: true,
        synonyms: ["envíos", " ", " repartos"],
        caveats: ["", "Sin las canceladas", ""],
      },
    };
    const stored = {
      base: { kind: "table", name: "t" },
      columns: [{ name: "a" }],
      meaning: { definition: "x", grain: "y", additive: false },
    };

    // Performs assertions.
    expect(cleanDefinition(typed)).toMatchObject({
      columns: [
        { name: "ruta", label: undefined },
        { name: "piloto", label: "Piloto" },
      ],
      filters: [{ column: "ruta", description: undefined }],
      meaning: { synonyms: ["envíos", "repartos"], caveats: ["Sin las canceladas"] },
    });
    expect(withDefaults(stored as unknown as Definition)).toMatchObject({
      filters: [],
      order_by: [],
      meaning: { synonyms: [], caveats: [] },
    });
  });

  it("turns what a person types into the argument each parameter takes", () => {
    // Performs assertions.
    expect(argument({ type: "array", items: { type: "string" } }, "R-1, R-2 ,")).toEqual([
      "R-1",
      "R-2",
    ]);
    expect(argument({ type: "array", items: { type: "integer" } }, "1,2")).toEqual([1, 2]);
    expect(argument({ type: ["number", "null"] }, "3.5")).toBe(3.5);
    expect(argument({ type: "string" }, "2026-03-01")).toBe("2026-03-01");
    expect(argument({ type: "boolean" }, true)).toBe(true);
    expect(argument({ type: "boolean" }, "false")).toBe(false);
    expect(argument({ type: "boolean" }, "true")).toBe(true);
  });

  it("drops the choices that no longer fit, so the form never shows one thing and saves another", () => {
    // Performs the test.
    const base = [
      { name: "ruta", kind: "text" as const },
      { name: "piloto", kind: "text" as const },
      { name: "total", kind: "number" as const },
    ];
    const before: Definition = {
      ...blankDefinition(),
      columns: [{ name: "ruta" }, { name: "total" }],
      filters: [
        { column: "ruta", op: "in", required: false },
        { column: "zona", op: "=", required: false },
      ],
      summary: {
        group_by: ["ruta", "piloto"],
        aggregates: [
          { fn: "sum", column: "total", as: "vendido" },
          { fn: "count", column: "ruta", as: "entregas" },
        ],
      },
      order_by: [
        { column: "vendido", direction: "desc" },
        { column: "piloto", direction: "asc" },
      ],
    };
    // Total is no longer chosen
    const after = prune({ ...before, columns: [{ name: "ruta" }] }, base);

    // Performs assertions.
    expect(after.filters.map((filter) => filter.column)).toEqual(["ruta"]);
    expect(after.summary?.group_by).toEqual(["ruta"]);
    expect(after.summary?.aggregates).toEqual([
      { fn: "sum", column: undefined, as: "vendido" },
      { fn: "count", column: undefined, as: "entregas" },
    ]);
    expect(after.order_by).toEqual([{ column: "vendido", direction: "desc" }]);
    // Before the base is read, no filter is judged
    expect(prune(before, []).filters).toHaveLength(2);
  });
});

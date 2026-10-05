import { describe, expect, it } from "vitest";
import { definitionSchema } from "../../src/creator/definition.js";

const meaning = {
  definition: "Pedidos entregados por ruta",
  grain: "pedido",
  additive: true,
};

/**
 * Lists the problems of a definition
 *
 * @param   definition  Definition to check
 *
 * @return  The messages, empty when it is valid
 */
function problems(definition: Record<string, unknown>): string[] {
  const parsed = definitionSchema.safeParse({ meaning, ...definition });

  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
}

describe("tool definition", () => {
  it("accepts a table or a pasted query with columns, filters, a summary and an order", () => {
    // Performs the test.
    const detail = definitionSchema.parse({
      base: { kind: "table", name: "ventas.pedidos" },
      columns: [{ name: "id" }, { name: "Fecha de entrega", label: "Entrega" }, { name: "total" }],
      filters: [{ column: "Fecha de entrega", op: "between", required: true }],
      order_by: [{ column: "total", direction: "desc" }],
      meaning,
    });
    const grouped = problems({
      base: { kind: "query", sql: "select ruta, total from pedidos" },
      columns: [{ name: "ruta" }, { name: "total" }],
      summary: {
        group_by: ["ruta"],
        aggregates: [
          { fn: "sum", column: "total", as: "monto" },
          { fn: "count", as: "pedidos" },
        ],
      },
      order_by: [{ column: "monto", direction: "desc" }],
    });

    // Performs assertions.
    expect(detail.filters[0]?.required).toBe(true);
    expect(detail.meaning.synonyms).toEqual([]);
    expect(grouped).toEqual([]);
  });

  it("refuses names that cannot be quoted safely", () => {
    // Performs assertions.
    expect(
      problems({ base: { kind: "table", name: 'pedidos"; drop' }, columns: [{ name: "id" }] }),
    ).not.toEqual([]);
    expect(
      problems({ base: { kind: "table", name: "a.b.c" }, columns: [{ name: "id" }] }),
    ).not.toEqual([]);
    expect(
      problems({ base: { kind: "table", name: "t" }, columns: [{ name: "id]" }] }),
    ).not.toEqual([]);
    expect(
      problems({ base: { kind: "table", name: "t" }, columns: [{ name: "a\nb" }] }),
    ).not.toEqual([]);
    expect(
      problems({ base: { kind: "table", name: "t" }, columns: [{ name: "ruta‮" }] }),
    ).not.toEqual([]);
  });

  it("refuses a definition that does not hold together", () => {
    // Performs the test.
    const base = { kind: "table", name: "pedidos" };
    const columns = [{ name: "ruta" }, { name: "total" }];

    // Performs assertions.
    expect(
      problems({
        base,
        columns,
        filters: [
          { column: "total", op: ">" },
          { column: "total", op: "<" },
        ],
      }),
    ).toContain("Cada columna lleva un solo filtro; para un rango usa between");
    expect(
      problems({
        base,
        columns,
        summary: { group_by: ["zona"], aggregates: [{ fn: "count", as: "n" }] },
      }),
    ).toContain("Se agrupa por zona, que no está entre las columnas");
    expect(
      problems({ base, columns, summary: { aggregates: [{ fn: "sum", as: "monto" }] } }),
    ).toContain("sum necesita una columna");
    expect(
      problems({
        base,
        columns,
        summary: { group_by: ["ruta"], aggregates: [{ fn: "count", as: "n" }] },
        order_by: [{ column: "total", direction: "asc" }],
      }),
    ).toContain("Se ordena por total, que no sale en el resultado");
    expect(problems({ base, columns: [{ name: "ruta" }, { name: "ruta" }] })).toContain(
      "Hay columnas repetidas",
    );
  });
});

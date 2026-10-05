import { describe, expect, it } from "vitest";
import { capResult } from "../../src/tools/cap.js";
import {
  applyFilter,
  FILTER_PARAM,
  filterable,
  filterHint,
  type RowFilter,
  takeFilter,
} from "../../src/tools/filter.js";

const orders = [
  { pedido: "P1", entrega: "2026-10-12", ruta: null, cliente: "Á", monto: "10.00" },
  { pedido: "P2", entrega: "2026-10-12 08:00", ruta: "Norte", cliente: "B", monto: "5.50" },
  { pedido: "P3", entrega: "2026-11-01", ruta: "", cliente: "B", monto: 2 },
  { pedido: "P4", entrega: null, ruta: "Sur", cliente: "B", monto: 1 },
];

/**
 * Builds a result with the order list and a total outside it
 *
 * @param   extra  More fields
 *
 * @return  The result
 */
function result(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { total_pedidos: 4, pedidos: orders, ...extra };
}

interface FilteredOrders {
  total_pedidos: number;
  pedidos: { pedido: string }[];
  filtro_filas: {
    lista: string;
    filas_despues: number;
    sin_dato: Record<string, number>;
    sumas?: Record<string, number>;
  };
  resumen_filtro?: Record<string, unknown>[];
  nota_filtro: string;
}

/**
 * Runs a filter and returns what it leaves, failing the test when it does not apply
 *
 * @param   filter  Filter
 * @param   data    Result to filter
 *
 * @return  The filtered result
 */
function filtered(filter: RowFilter, data = result()): FilteredOrders {
  const outcome = applyFilter(data, filter);
  if (!outcome.ok) {
    throw new Error(outcome.message);
  }

  return outcome.data as unknown as FilteredOrders;
}

/**
 * Lists the order ids a filter leaves
 *
 * @param   filter  Filter
 *
 * @return  The ids
 */
function ids(filter: RowFilter): string[] {
  return filtered(filter).pedidos.map((order) => order.pedido);
}

describe("row filter", () => {
  it("takes the filter out of the arguments, also as JSON text, and names a bad one", () => {
    // Performs the test.
    const asObject = takeFilter({
      cliente: 5,
      [FILTER_PARAM]: { where: [{ field: "a", op: "empty" }] },
    });
    const asText = takeFilter({ [FILTER_PARAM]: '{"where":[{"field":"a","op":"=","value":1}]}' });
    const none = takeFilter({ cliente: 5 });
    const bad = takeFilter({ cliente: 5, [FILTER_PARAM]: { where: [{ field: "a", op: "like" }] } });

    // Performs assertions.
    expect(asObject).toMatchObject({ args: { cliente: 5 }, filter: { where: [{ field: "a" }] } });
    expect(asText).toMatchObject({ args: {}, filter: { where: [{ field: "a", value: 1 }] } });
    expect(none).toEqual({ filter: null, args: { cliente: 5 } });
    expect(bad).toMatchObject({ args: { cliente: 5 } });
    expect("error" in bad && bad.error).toContain(FILTER_PARAM);
  });

  it("compares a bare date by day and counts the rows without a value", () => {
    // Performs the test.
    const data = filtered({ where: [{ field: "entrega", op: "=", value: "2026-10-12" }] });

    // Performs assertions.
    expect(data.pedidos.map((order) => order.pedido)).toEqual(["P1", "P2"]);
    expect(data.filtro_filas).toEqual({
      lista: "pedidos",
      filas_antes: 4,
      filas_despues: 2,
      sin_dato: { entrega: 1 },
    });
    expect(data.total_pedidos).toBe(4);
    expect(data.nota_filtro).toContain("antes del filtro");
  });

  it("treats null and blank as empty, and matches between, in and contains without accents", () => {
    // Performs assertions.
    expect(ids({ where: [{ field: "ruta", op: "empty" }] })).toEqual(["P1", "P3"]);
    expect(
      ids({ where: [{ field: "entrega", op: "between", value: ["2026-10-01", "2026-10-31"] }] }),
    ).toEqual(["P1", "P2"]);
    expect(ids({ where: [{ field: "ruta", op: "in", value: ["norte", "SUR"] }] })).toEqual([
      "P2",
      "P4",
    ]);
    expect(ids({ where: [{ field: "cliente", op: "contains", value: "a" }] })).toEqual(["P1"]);
    expect(ids({ where: [{ field: "monto", op: ">=", value: 5 }] })).toEqual(["P1", "P2"]);
    expect(ids({ where: [{ field: "ruta", op: "!=", value: "Norte" }] })).toEqual(["P4"]);
  });

  it("splits every row into met, not met and without a value", () => {
    // Performs the test.
    const count = (op: "<" | ">=") =>
      filtered({ where: [{ field: "entrega", op, value: "2026-10-13" }] }).filtro_filas;

    // Performs assertions.
    expect(
      count("<").filas_despues + count(">=").filas_despues + (count("<").sin_dato.entrega ?? 0),
    ).toBe(4);
  });

  it("counts and sums by group over what is left", () => {
    // Performs the test.
    const data = filtered({
      where: [{ field: "entrega", op: "not_empty", value: null }],
      count_by: ["cliente"],
      sum: ["monto"],
    });

    // Performs assertions.
    expect(data.resumen_filtro).toEqual([
      { cliente: "B", filas: 2, monto: 7.5 },
      { cliente: "Á", filas: 1, monto: 10 },
    ]);
    expect(data.filtro_filas.sumas).toEqual({ monto: 17.5 });
  });

  it("names the real columns when one does not exist, and works on the list asked for", () => {
    // Performs the test.
    const unknown = applyFilter(result(), {
      where: [{ field: "fecha", op: "empty", value: null }],
    });
    const heavier = result({
      detalle: Array.from({ length: 50 }, (_, index) => ({ linea: index, texto: "x".repeat(40) })),
    });
    const asked = filtered(
      { where: [{ field: "ruta", op: "empty", value: null }], list: "pedidos" },
      heavier,
    );
    const none = applyFilter({ total: 3 }, { where: [] });

    // Performs assertions.
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.message).toContain("entrega");
    expect(asked.filtro_filas.lista).toBe("pedidos");
    expect(none.ok).toBe(false);
  });

  it("offers the filter in the note of a cut result, naming the plain columns", async () => {
    // Performs the test.
    const data = {
      filas: Array.from({ length: 3_000 }, (_, index) => ({
        codigo: index,
        nombre: `Cliente ${index}`,
        extra: { a: 1 },
      })),
    };
    const target = filterable(data);
    const capped = await capResult(data, 40_000, null, target ? filterHint(target) : "");

    // Performs assertions.
    expect(target).toEqual({ list: "filas", columns: ["codigo", "nombre"] });
    expect(capped.ok && String(capped.data.nota)).toContain(FILTER_PARAM);
    expect(capped.ok && String(capped.data.nota)).toContain("Columnas: codigo, nombre.");
  });
});

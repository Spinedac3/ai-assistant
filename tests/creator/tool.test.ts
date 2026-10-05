import { describe, expect, it } from "vitest";
import { normalizeRows } from "../../src/creator/columns.js";
import { definitionSchema } from "../../src/creator/definition.js";
import {
  type CreatedTool,
  descriptionOf,
  inputSchemaOf,
  outputColumnsOf,
  outputSchemaOf,
} from "../../src/creator/tool.js";

const columns: CreatedTool["columns"] = [
  { name: "Fecha", kind: "datetime" },
  { name: "ruta", kind: "text" },
  { name: "total", kind: "number" },
  { name: "a_tiempo", kind: "boolean" },
  { name: "dia", kind: "date" },
];

/**
 * Builds a created tool over the test columns
 *
 * @param   definition  Definition fields
 *
 * @return  The created tool
 */
function created(definition: Record<string, unknown>): CreatedTool {
  return {
    name: "entregas",
    sourceCode: "demo",
    columns,
    spec: definitionSchema.parse({
      base: { kind: "table", name: "entregas" },
      columns: [{ name: "ruta" }, { name: "total", label: "Monto" }],
      meaning: { definition: "Entregas por ruta.", grain: "entrega", additive: false },
      ...definition,
    }),
  };
}

describe("created tool", () => {
  it("types each filter parameter by its operator and its column", () => {
    // Performs the test.
    const schema = inputSchemaOf(
      created({
        filters: [
          { column: "Fecha", op: "between", required: true },
          { column: "ruta", op: "in" },
          { column: "total", op: ">=" },
          { column: "a_tiempo", op: "=" },
          { column: "dia", op: "<=" },
        ],
      }),
    );
    const properties = schema.properties as Record<string, Record<string, unknown>>;

    // Performs assertions.
    expect(schema.required).toEqual(["fecha"]);
    expect(schema.additionalProperties).toBe(false);
    expect(properties.fecha).toMatchObject({ type: "array", minItems: 2, maxItems: 2 });
    expect(String(properties.fecha?.description)).toContain("día entero");
    expect(properties.ruta).toMatchObject({
      type: "array",
      minItems: 1,
      items: { type: "string" },
    });
    expect(properties.total).toMatchObject({ type: "number" });
    expect(properties.a_tiempo).toMatchObject({ type: "boolean" });
    expect(properties.dia).toMatchObject({ type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
  });

  it("returns the grouped columns and aggregates, min and max keeping their column's kind", () => {
    // Performs the test.
    const tool = created({
      columns: [{ name: "ruta" }, { name: "Fecha" }, { name: "total" }],
      summary: {
        group_by: ["ruta"],
        aggregates: [
          { fn: "sum", column: "total", as: "monto" },
          { fn: "max", column: "Fecha", as: "ultima" },
          { fn: "count", as: "entregas" },
        ],
      },
    });
    const schema = outputSchemaOf(tool);

    // Performs assertions.
    expect(outputColumnsOf(tool)).toEqual([
      { name: "ruta", kind: "text" },
      { name: "monto", kind: "number" },
      { name: "ultima", kind: "datetime" },
      { name: "entregas", kind: "number" },
    ]);
    expect(schema.required).toEqual(["filas", "total_filas"]);
    expect(JSON.stringify(schema)).toContain('"monto":{"type":["number","null"]}');
  });

  it("tells the model what a row is, whether to add it up, its zone, its synonyms and caveats", () => {
    // Performs the test.
    const text = descriptionOf(
      created({
        meaning: {
          definition: "Entregas por ruta.",
          grain: "entrega",
          additive: false,
          synonyms: ["despachos"],
          caveats: ["Excluye devoluciones."],
        },
      }),
      "America/Guatemala",
    );

    // Performs assertions.
    expect(text).toContain("Cada fila es: entrega. Columnas: ruta, total (Monto).");
    expect(text).toContain("NO se suman");
    expect(text).toContain("hora de America/Guatemala");
    expect(text).toContain("También se le dice: despachos.");
    expect(text).toContain("Ojo: Excluye devoluciones.");
  });

  it("gives a one-bit MySQL field and 0/1 flags as booleans, and exact decimals as numbers", () => {
    // Performs the test.
    const rows = normalizeRows({
      columns: ["activo", "flag", "monto"],
      kinds: { activo: "boolean", flag: "boolean", monto: "number" },
      rows: [{ activo: Buffer.from([1]), flag: 0, monto: "12.50" }],
    });

    // Performs assertions.
    expect(rows).toEqual([{ activo: true, flag: false, monto: 12.5 }]);
  });
});

import { describe, expect, it } from "vitest";
import { normalizeRows } from "../../src/creator/columns.js";
import { definitionSchema } from "../../src/creator/definition.js";
import {
  type CreatedTool,
  descriptionOf,
  detailOf,
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

  it("closes a filter to its listed values and tells the model what each means and how to use it", () => {
    // Performs the test.
    const schema = inputSchemaOf(
      created({
        filters: [
          {
            column: "ruta",
            op: "=",
            description: "La ruta del camión.",
            values: [{ value: "R-Norte-1", meaning: "norte" }, { value: "R-Sur-2" }],
          },
          { column: "Fecha", op: "between", required: true, examples: ["2026-01-01"] },
        ],
      }),
    );
    const properties = schema.properties as Record<
      string,
      { enum?: unknown[]; description: string }
    >;
    const ruta = properties.ruta as { enum?: unknown[]; description: string };
    const fecha = properties.fecha as { enum?: unknown[]; description: string };

    // Performs assertions.
    expect(ruta.enum).toEqual(["R-Norte-1", "R-Sur-2"]);
    expect(ruta.description).toContain('Valores posibles: "R-Norte-1" (norte), "R-Sur-2".');
    expect(ruta.description).toContain("La ruta del camión.");
    expect(ruta.description).toContain("Si se omite, no se filtra por ruta.");
    expect(fecha.enum).toBeUndefined();
    expect(fecha.description).toContain("fechas relativas");
    expect(fecha.description).toContain('Ejemplos reales: "2026-01-01".');
    expect(fecha.description).not.toContain("Si se omite");
  });

  it("refuses listed values on an operator that does not take one of them, or repeated", () => {
    // Performs the test.
    const parse = (filter: Record<string, unknown>) =>
      definitionSchema.safeParse({
        base: { kind: "table", name: "entregas" },
        columns: [{ name: "ruta" }],
        filters: [filter],
        meaning: { definition: "Entregas." },
      }).success;

    // Performs assertions.
    expect(parse({ column: "ruta", op: "contains", values: [{ value: "R" }] })).toBe(false);
    expect(parse({ column: "ruta", op: "in", values: [{ value: "R" }, { value: "R" }] })).toBe(
      false,
    );
    expect(parse({ column: "ruta", op: "in", values: [{ value: "R" }] })).toBe(true);
  });

  it("brings the detail behind the totals with the chosen columns and the orders they allow", () => {
    // Performs the test.
    const tool = created({
      columns: [{ name: "ruta" }, { name: "total" }],
      summary: {
        group_by: ["ruta"],
        aggregates: [{ fn: "sum", column: "total", as: "monto" }],
        with_detail: true,
      },
      order_by: [
        { column: "monto", direction: "desc" },
        { column: "ruta", direction: "asc" },
      ],
    });
    const detail = detailOf(tool.spec);
    const schema = outputSchemaOf(tool) as unknown as {
      properties: Record<string, { items?: { required?: string[] } }>;
      required: string[];
    };

    // Performs assertions.
    expect(detail.summary).toBeUndefined();
    expect(detail.order_by).toEqual([{ column: "ruta", direction: "asc" }]);
    expect(schema.required).toEqual(["filas", "total_filas", "detalle", "total_detalle"]);
    expect(schema.properties.filas?.items?.required).toEqual(["ruta", "monto"]);
    expect(schema.properties.detalle?.items?.required).toEqual(["ruta", "total"]);
    expect(descriptionOf(tool, "UTC")).toContain("detalle trae cada registro");
  });

  it("says what a row is from the totals when the person left it unsaid", () => {
    // Performs the test.
    const grouped = created({
      meaning: { definition: "Montos." },
      summary: { group_by: ["ruta"], aggregates: [{ fn: "count", as: "n" }] },
    });
    const whole = created({
      meaning: { definition: "Montos." },
      summary: { group_by: [], aggregates: [{ fn: "count", as: "n" }] },
    });

    // Performs assertions.
    expect(descriptionOf(grouped, "UTC")).toContain("Cada fila es: el total de cada ruta.");
    expect(descriptionOf(whole, "UTC")).toContain("Cada fila es: el total de todo lo filtrado.");
    expect(grouped.spec.meaning.additive).toBe(true);
  });
});

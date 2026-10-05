import { describe, expect, it } from "vitest";
import { definitionSchema } from "../../src/creator/definition.js";
import { buildQuery, paramName } from "../../src/creator/sql.js";
import type { ColumnKind } from "../../src/sources/engines.js";

const kinds = new Map<string, ColumnKind>([
  ["Fecha de entrega", "datetime"],
  ["dia", "date"],
  ["codigo", "text"],
  ["total", "number"],
]);

const meaning = { definition: "Pedidos", grain: "pedido", additive: true };

const detail = definitionSchema.parse({
  base: { kind: "table", name: "ventas.pedidos" },
  columns: [{ name: "id" }, { name: "Fecha de entrega" }, { name: "total" }],
  filters: [
    { column: "Fecha de entrega", op: "between" },
    { column: "ruta", op: "in" },
    { column: "cliente", op: "contains" },
    { column: "total", op: ">=" },
    { column: "nota", op: "empty" },
  ],
  order_by: [{ column: "total", direction: "desc" }],
  meaning,
});

describe("creator SQL", () => {
  it("names each filter parameter after its column", () => {
    // Performs assertions.
    expect(paramName("Fecha de entrega")).toBe("fecha_de_entrega");
    expect(paramName("Año")).toBe("ano");
    expect(paramName("2do turno")).toBe("c_2do_turno");
  });

  it("writes each engine's quotes and placeholders, and binds every value", () => {
    // Performs the test.
    const args = { ruta: ["Norte", "Sur"], total: 10 };
    const postgres = buildQuery(detail, "postgres", null, args, kinds);
    const mysql = buildQuery(detail, "mysql", null, args, kinds);
    const mssql = buildQuery(detail, "mssql", null, args, kinds);

    // Performs assertions.
    expect(postgres.sql).toBe(
      'SELECT "id", "Fecha de entrega", "total"\nFROM "ventas"."pedidos" AS base\n' +
        'WHERE "ruta" IN ($1, $2) AND "total" >= $3\nORDER BY "total" DESC',
    );
    expect(mysql.sql).toContain(
      "FROM `ventas`.`pedidos` AS base\nWHERE `ruta` IN (?, ?) AND `total` >= ?",
    );
    expect(mssql.sql).toContain(
      "FROM [ventas].[pedidos] AS base\nWHERE [ruta] IN (@p1, @p2) AND [total] >= @p3",
    );
    expect(postgres.params).toEqual(["Norte", "Sur", 10]);
  });

  it("leaves out the filters not given, and keeps a bare date's whole day", () => {
    // Performs the test.
    const none = buildQuery(detail, "postgres", null, {}, kinds);
    const range = buildQuery(
      detail,
      "postgres",
      null,
      {
        fecha_de_entrega: ["2026-10-01", "2026-10-31"],
      },
      kinds,
    );
    const numbers = buildQuery(detail, "postgres", null, { fecha_de_entrega: [1, 5] }, kinds);

    // Performs assertions.
    expect(none.sql).not.toContain("WHERE");
    expect(range.sql).toContain('"Fecha de entrega" >= $1 AND "Fecha de entrega" < $2');
    expect(range.params).toEqual(["2026-10-01", "2026-11-01"]);
    expect(numbers.sql).toContain('"Fecha de entrega" BETWEEN $1 AND $2');
  });

  it("searches text as written, with its own wildcards escaped as each engine reads them", () => {
    // Performs the test.
    const postgres = buildQuery(detail, "postgres", null, { cliente: "50%_a" }, kinds);
    const mysql = buildQuery(detail, "mysql", null, { cliente: "x" }, kinds);
    const mssql = buildQuery(detail, "mssql", null, { cliente: "x" }, kinds);

    // Performs assertions.
    expect(postgres.sql).toContain(`CAST("cliente" AS text) ILIKE $1 ESCAPE '\\'`);
    expect(postgres.params).toEqual(["%50\\%\\_a%"]);
    expect(mysql.sql).toContain(`CAST(\`cliente\` AS char) LIKE ? ESCAPE '\\\\'`);
    expect(mssql.sql).toContain("CAST([cliente] AS nvarchar(max)) LIKE @p1");
  });

  it("checks for empty or filled values without a parameter", () => {
    // Performs the test.
    const empty = buildQuery(detail, "postgres", null, { nota: true }, kinds);
    const filled = buildQuery(detail, "postgres", null, { nota: false }, kinds);

    // Performs assertions.
    expect(empty.sql).toContain('"nota" IS NULL');
    expect(filled.sql).toContain('"nota" IS NOT NULL');
    expect(empty.params).toEqual([]);
  });

  it("wraps a pasted query on its own lines and groups with its aggregates", () => {
    // Performs the test.
    const grouped = definitionSchema.parse({
      base: { kind: "query", sql: "select ruta, total from pedidos -- todos" },
      columns: [{ name: "ruta" }, { name: "total" }],
      summary: {
        group_by: ["ruta"],
        aggregates: [
          { fn: "sum", column: "total", as: "monto" },
          { fn: "avg", column: "total", as: "promedio" },
          { fn: "count", as: "pedidos" },
        ],
      },
      order_by: [{ column: "monto", direction: "desc" }],
      meaning,
    });
    const built = buildQuery(
      grouped,
      "mssql",
      "select ruta, total from pedidos -- todos",
      {},
      kinds,
    );

    // Performs assertions.
    expect(built.sql).toBe(
      "SELECT [ruta], SUM(CAST([total] AS DECIMAL(38, 6))) AS [monto], AVG(CAST([total] AS DECIMAL(38, 6))) AS [promedio], COUNT(*) AS [pedidos]\n" +
        "FROM (\nselect ruta, total from pedidos -- todos\n) AS base\nGROUP BY [ruta]\nORDER BY [monto] DESC",
    );
  });

  it("refuses two filters whose parameters would share a name", () => {
    // Performs the test.
    const parsed = definitionSchema.safeParse({
      base: { kind: "table", name: "t" },
      columns: [{ name: "año" }],
      filters: [
        { column: "año", op: "=" },
        { column: "ano", op: "=" },
      ],
      meaning,
    });

    // Performs assertions.
    expect(parsed.success).toBe(false);
  });

  it("takes a bare date as the whole day only on date columns, also in a list", () => {
    // Performs the test.
    const spec = definitionSchema.parse({
      base: { kind: "table", name: "t" },
      columns: [{ name: "dia" }],
      filters: [
        { column: "dia", op: "in" },
        { column: "codigo", op: "=" },
      ],
      meaning,
    });
    const days = buildQuery(spec, "postgres", null, { dia: ["2026-10-01", "2026-10-03"] }, kinds);
    const text = buildQuery(spec, "postgres", null, { codigo: "2026-10-01" }, kinds);

    // Performs assertions.
    expect(days.sql).toContain('(("dia" >= $1 AND "dia" < $2) OR ("dia" >= $3 AND "dia" < $4))');
    expect(days.params).toEqual(["2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"]);
    expect(text.sql).toContain('"codigo" = $1');
    expect(text.params).toEqual(["2026-10-01"]);
  });

  it("escapes the bracket wildcard of SQL Server", () => {
    // Performs the test.
    const mssql = buildQuery(detail, "mssql", null, { cliente: "[a-z]" }, kinds);

    // Performs assertions.
    expect(mssql.params).toEqual(["%\\[a-z]%"]);
  });
});

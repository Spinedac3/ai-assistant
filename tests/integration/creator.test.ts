import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_ENGINES } from "../../src/cli/demoEngines.js";
import { describeBase, normalizeRows } from "../../src/creator/columns.js";
import { definitionSchema } from "../../src/creator/definition.js";
import { checkPasted } from "../../src/creator/pasted.js";
import { buildQuery } from "../../src/creator/sql.js";
import { sourceScope, toolFrom } from "../../src/creator/tool.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { type EngineName, runQuery } from "../../src/sources/engines.js";
import { saveSource } from "../../src/sources/registry.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { Secrets } from "../../src/vault/envelope.js";
import { freshDatabase } from "./support/database.js";

const LIMITS = { timeoutMs: 10_000, maxRows: 10_000 };
const meaning = { definition: "Pedidos de la distribuidora", grain: "pedido", additive: true };
const secrets = Secrets.fromKey(randomBytes(32));

let database: DatabaseHandle;

/**
 * Tells whether a demo engine is running and seeded; SQL Server is optional on a laptop
 *
 * @param   engine  Engine
 *
 * @return  Whether its reader can query
 */
async function seeded(engine: EngineName): Promise<boolean> {
  try {
    await runQuery(DEMO_ENGINES[engine].reader, "select 1 as uno", [], LIMITS);
    return true;
  } catch {
    return false;
  }
}

const available = (
  await Promise.all(
    (Object.keys(DEMO_ENGINES) as EngineName[]).map(async (engine) =>
      (await seeded(engine)) ? engine : null,
    ),
  )
).filter((engine): engine is EngineName => engine !== null);

/**
 * Runs a definition on every available engine and returns the normalized rows of each
 *
 * @param   definition  Tool definition
 * @param   args        Filter values
 *
 * @return  Rows by engine
 */
async function onEveryEngine(
  definition: Record<string, unknown>,
  args: Record<string, unknown> = {},
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const spec = definitionSchema.parse({ meaning, ...definition });
  const found: Record<string, Array<Record<string, unknown>>> = {};
  for (const engine of available) {
    const pasted = spec.base.kind === "query" ? checkPasted(spec.base.sql, engine) : null;
    if (pasted && !pasted.ok) {
      throw new Error(pasted.message);
    }
    const query = buildQuery(spec, engine, pasted?.sql ?? null, args);
    found[engine] = normalizeRows(
      await runQuery(DEMO_ENGINES[engine].reader, query.sql, query.params, LIMITS),
    );
  }

  return found;
}

describe("creator on the demo engines", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    for (const engine of available) {
      const reader = DEMO_ENGINES[engine].reader;
      await saveSource(
        database.db,
        secrets,
        {
          code: `demo-${engine}`,
          name: `Demo ${engine}`,
          ...reader,
          timeZone: "America/Guatemala",
        },
        1,
      );
    }
  });

  afterAll(async () => {
    await database.close();
  });

  it("has the engines to test against", () => {
    // Performs assertions.
    expect(available).toEqual(expect.arrayContaining(["postgres", "mysql"]));
  });

  it("reads what each column holds the same way on every engine", async () => {
    // Performs the test.
    const kinds: Record<string, Record<string, string>> = {};
    for (const engine of available) {
      for (const table of ["pedidos", "productos", "clientes"]) {
        const columns = await describeBase(
          DEMO_ENGINES[engine].reader,
          { kind: "table", name: table },
          null,
          LIMITS,
        );
        kinds[`${engine}.${table}`] = Object.fromEntries(columns.map((c) => [c.name, c.kind]));
      }
    }

    // Performs assertions.
    for (const engine of available) {
      expect(kinds[`${engine}.pedidos`]).toEqual({
        id: "number",
        cliente_id: "number",
        fecha: "datetime",
        estado: "text",
        total: "number",
      });
      expect(kinds[`${engine}.productos`]?.refrigerado).toBe("boolean");
      expect(kinds[`${engine}.clientes`]?.creado_en).toBe("date");
    }
  });

  it("gives the same rows on every engine: numbers, booleans and dates alike", async () => {
    // Performs the test.
    const totals = await onEveryEngine(
      {
        base: { kind: "table", name: "pedidos" },
        columns: [{ name: "estado" }, { name: "total" }, { name: "fecha" }],
        filters: [{ column: "fecha", op: "between" }],
        summary: {
          group_by: ["estado"],
          aggregates: [
            { fn: "sum", column: "total", as: "monto" },
            { fn: "count", as: "pedidos" },
          ],
        },
        order_by: [{ column: "estado", direction: "asc" }],
      },
      { fecha: ["2026-01-01", "2026-06-30"] },
    );
    const products = await onEveryEngine(
      {
        base: { kind: "query", sql: "select sku, precio, refrigerado from productos;" },
        columns: [{ name: "sku" }, { name: "precio" }, { name: "refrigerado" }],
        filters: [{ column: "refrigerado", op: "=" }],
        order_by: [{ column: "sku", direction: "asc" }],
      },
      { refrigerado: true },
    );

    // Performs assertions.
    const [first, ...others] = available;
    expect(totals[first as string]?.length).toBeGreaterThan(0);
    for (const engine of others) {
      expect(totals[engine]).toEqual(totals[first as string]);
      expect(products[engine]).toEqual(products[first as string]);
    }
    expect(typeof totals[first as string]?.[0]?.monto).toBe("number");
    expect(typeof totals[first as string]?.[0]?.pedidos).toBe("number");
    expect(products[first as string]?.every((row) => row.refrigerado === true)).toBe(true);
  });

  it("runs a created tool through the registry, on its source's permission and zone", async () => {
    // Performs the test.
    const spec = definitionSchema.parse({
      base: { kind: "table", name: "entregas" },
      columns: [{ name: "ruta" }, { name: "entregado_en" }, { name: "a_tiempo" }],
      filters: [
        { column: "ruta", op: "in", required: true, description: "Rutas de reparto." },
        { column: "entregado_en", op: "between" },
      ],
      summary: { group_by: ["ruta"], aggregates: [{ fn: "count", as: "entregas" }] },
      order_by: [{ column: "ruta", direction: "asc" }],
      meaning: { ...meaning, synonyms: ["despachos"], caveats: ["Una entrega por pedido."] },
    });
    const outcomes: Record<string, unknown> = {};
    let described = "";
    for (const engine of available) {
      const code = `demo-${engine}`;
      const columns = await describeBase(DEMO_ENGINES[engine].reader, spec.base, null, LIMITS);
      const tool = toolFrom(
        { name: `entregas_${engine}`, sourceCode: code, spec, columns },
        { db: database.db, secrets, appTimeZone: "UTC" },
        "America/Guatemala",
      );
      described = tool.definition.description;
      const registry = new ToolRegistry(database.db);
      registry.register(tool);
      const caller = { userId: 1, email: "ana@example.com", scopes: new Set([sourceScope(code)]) };
      const run = (args: Record<string, unknown>, who = caller) =>
        registry.execute(tool.definition.name, args, who, { origin: "chat", timeZone: "UTC" });
      outcomes[engine] = JSON.parse((await run({ ruta: ["R-Norte-1", "R-Sur-1"] })).text);
      outcomes[`${engine} sin ruta`] = JSON.parse((await run({})).text).error;
      outcomes[`${engine} sin permiso`] = JSON.parse(
        (await run({ ruta: ["R-Norte-1"] }, { ...caller, scopes: new Set(["chat.use"]) })).text,
      ).error;
    }

    // Performs assertions.
    const [first, ...others] = available;
    expect(outcomes[first as string]).toMatchObject({ total_filas: 2 });
    for (const engine of others) {
      expect(outcomes[engine]).toEqual(outcomes[first as string]);
    }
    for (const engine of available) {
      expect(outcomes[`${engine} sin ruta`]).toBe("invalid_arguments");
      expect(outcomes[`${engine} sin permiso`]).toBe("missing_scope");
    }
    expect(described).toContain("hora de America/Guatemala");
    expect(described).toContain("despachos");
    expect(described).toContain("Ojo: Una entrega por pedido.");
  });
});

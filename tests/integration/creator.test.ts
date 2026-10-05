import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEMO_ENGINES } from "../../src/cli/demoEngines.js";
import { runChecks, runnerFor } from "../../src/creator/checks.js";
import { describeBase, normalizeRows } from "../../src/creator/columns.js";
import { definitionSchema } from "../../src/creator/definition.js";
import { checkPasted } from "../../src/creator/pasted.js";
import { buildQuery } from "../../src/creator/sql.js";
import { CreatedTools, saveDefinition } from "../../src/creator/store.js";
import { toolFrom } from "../../src/creator/tool.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { roleScopes, roles, scopes, toolDefinitions } from "../../src/db/schema.js";
import { type EngineName, runQuery } from "../../src/sources/engines.js";
import { deleteSource, saveSource, sourceScope } from "../../src/sources/registry.js";
import { calculateTool } from "../../src/tools/native/calculate.js";
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
    const info = DEMO_ENGINES[engine].reader;
    const columns = await describeBase(info, spec.base, pasted?.sql ?? null, LIMITS);
    const kinds = new Map(columns.map((column) => [column.name, column.kind]));
    const query = buildQuery(spec, engine, pasted?.sql ?? null, args, kinds);
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

  it("gives each source its permission, and takes it with its grants when the source goes", async () => {
    // Performs the test.
    const engine = available[0] as EngineName;
    await saveSource(
      database.db,
      secrets,
      { code: "temporal", name: "Temporal", ...DEMO_ENGINES[engine].reader },
      1,
    );
    const [scope] = await database.db
      .select()
      .from(scopes)
      .where(eq(scopes.code, "sources.temporal.use"));
    // The admin role holds it on its own; another role gets it as the admin would grant it
    const [admin] = await database.db.select().from(roles).where(eq(roles.code, "admin"));
    const [user] = await database.db.select().from(roles).where(eq(roles.code, "user"));
    const heldByAdmin = await database.db
      .select()
      .from(roleScopes)
      .where(eq(roleScopes.roleId, admin?.id ?? 0));
    await database.db.insert(roleScopes).values({ roleId: user?.id ?? 0, scopeId: scope?.id ?? 0 });
    await saveDefinition(database.db, {
      name: "temporal_pedidos",
      sourceCode: "temporal",
      spec: definitionSchema.parse({
        base: { kind: "table", name: "pedidos" },
        columns: [{ name: "id" }],
        meaning,
      }),
      columns: [{ name: "id", kind: "number" }],
      userId: 1,
    });
    const inUse = await deleteSource(database.db, "temporal");
    await database.db.delete(toolDefinitions).where(eq(toolDefinitions.sourceCode, "temporal"));
    const deleted = await deleteSource(database.db, "temporal");
    const left = await database.db
      .select()
      .from(scopes)
      .where(eq(scopes.code, "sources.temporal.use"));
    const grants = await database.db
      .select()
      .from(roleScopes)
      .where(eq(roleScopes.scopeId, scope?.id ?? 0));

    // Performs assertions.
    expect(scope).toMatchObject({
      sensitive: true,
      description: "Usar las herramientas de la fuente Temporal",
    });
    expect(heldByAdmin.some((grant) => grant.scopeId === scope?.id)).toBe(true);
    expect(inUse).toBe("in_use");
    expect(deleted).toBe("deleted");
    expect(left).toEqual([]);
    expect(grants).toEqual([]);
    expect(await deleteSource(database.db, "temporal")).toBe("missing");
  });

  it("keeps the registry in step: published tools in, drafts out, natives untouched", async () => {
    // Performs the test.
    const engine = available[0] as EngineName;
    const registry = new ToolRegistry(database.db);
    registry.register(calculateTool);
    const created = new CreatedTools(registry, { db: database.db, secrets, appTimeZone: "UTC" });
    const spec = definitionSchema.parse({
      base: { kind: "table", name: "pedidos" },
      columns: [{ name: "id" }, { name: "total" }],
      meaning,
    });
    const stored = await saveDefinition(database.db, {
      name: "pedidos_sync",
      sourceCode: `demo-${engine}`,
      spec,
      columns: [
        { name: "id", kind: "number" },
        { name: "total", kind: "number" },
      ],
      userId: 1,
    });
    created.sync(stored, null);
    const asDraft = registry.has("pedidos_sync");
    await database.db
      .update(toolDefinitions)
      .set({ status: "published", publishedAt: new Date() })
      .where(eq(toolDefinitions.name, "pedidos_sync"));
    const loaded = await created.load();
    const published = registry.has("pedidos_sync");
    created.sync({ ...stored, name: "calculate", status: "published" }, null);
    created.drop("calculate");
    created.drop("pedidos_sync");

    // Performs assertions.
    expect(asDraft).toBe(false);
    expect(loaded).toBeGreaterThanOrEqual(1);
    expect(published).toBe(true);
    expect(created.isNative("calculate")).toBe(true);
    expect(registry.has("calculate")).toBe(true);
    expect(registry.has("pedidos_sync")).toBe(false);
  });

  it("passes its metamorphic checks on every engine, with a table and with a pasted query", async () => {
    // Performs the test.
    const definitions = [
      {
        base: { kind: "table", name: "entregas" },
        columns: [{ name: "ruta" }, { name: "entregado_en" }, { name: "a_tiempo" }],
      },
      {
        base: {
          kind: "query",
          sql: "select e.ruta, e.entregado_en, e.a_tiempo, p.total from entregas e join pedidos p on p.id = e.pedido_id",
        },
        columns: [
          { name: "ruta" },
          { name: "entregado_en" },
          { name: "a_tiempo" },
          { name: "total" },
        ],
      },
    ];
    const outcomes: Record<string, unknown> = {};
    for (const engine of available) {
      for (const [index, definition] of definitions.entries()) {
        const spec = definitionSchema.parse({
          ...definition,
          filters: [
            { column: "ruta", op: "=" },
            { column: "entregado_en", op: "between" },
            { column: "a_tiempo", op: "=" },
          ],
          summary: {
            group_by: ["ruta"],
            aggregates: [{ fn: "count", as: "entregas" }],
          },
          meaning,
        });
        const info = DEMO_ENGINES[engine].reader;
        const pasted = spec.base.kind === "query" ? checkPasted(spec.base.sql, engine) : null;
        const sql = pasted?.ok ? pasted.sql : null;
        const columns = await describeBase(info, spec.base, sql, LIMITS);
        const results = await runChecks(
          { name: "entregas", sourceCode: `demo-${engine}`, spec, columns },
          runnerFor(info, spec.base, sql, LIMITS, new Map(columns.map((c) => [c.name, c.kind]))),
        );
        outcomes[`${engine} ${index}`] = results.map((result) => [
          result.name,
          result.ok,
          result.skipped ?? false,
        ]);
      }
    }

    // Performs assertions.
    for (const outcome of Object.values(outcomes)) {
      expect(outcome).toEqual([
        ["runs", true, false],
        ["shape", true, false],
        ["filter_shrinks", true, false],
        ["sum_adds_up", true, false],
        ["range_splits", true, false],
      ]);
    }
  });

  it("reads Postgres dates that carry a zone in the zone the tool declares", async () => {
    // Performs the test.
    const result = await runQuery(
      DEMO_ENGINES.postgres.reader,
      "select '2026-01-01 00:00:00+00'::timestamptz as momento",
      [],
      { ...LIMITS, timeZone: "America/Guatemala" },
    );

    // Performs assertions.
    expect(result.rows[0]?.momento).toBe("2025-12-31 18:00:00-06");
  });

  it("loads every stored tool it can, leaving out one that no longer reads right", async () => {
    // Performs the test.
    const engine = available[0] as EngineName;
    const registry = new ToolRegistry(database.db);
    const created = new CreatedTools(registry, { db: database.db, secrets, appTimeZone: "UTC" });
    const good = definitionSchema.parse({
      base: { kind: "table", name: "pedidos" },
      columns: [{ name: "id" }],
      meaning,
    });
    for (const name of ["rota_carga", "buena_carga"]) {
      await saveDefinition(database.db, {
        name,
        sourceCode: `demo-${engine}`,
        spec: good,
        columns: [{ name: "id", kind: "number" }],
        userId: 1,
      });
    }
    // A definition stored before its shape changed
    await database.db
      .update(toolDefinitions)
      .set({ status: "published", spec: { base: { kind: "table" } } as never })
      .where(eq(toolDefinitions.name, "rota_carga"));
    await database.db
      .update(toolDefinitions)
      .set({ status: "published" })
      .where(eq(toolDefinitions.name, "buena_carga"));
    const loaded = await created.load();
    await database.db.delete(toolDefinitions).where(eq(toolDefinitions.name, "rota_carga"));
    await database.db.delete(toolDefinitions).where(eq(toolDefinitions.name, "buena_carga"));

    // Performs assertions.
    expect(registry.has("buena_carga")).toBe(true);
    expect(registry.has("rota_carga")).toBe(false);
    expect(loaded).toBeGreaterThanOrEqual(1);
  });

  it("never takes over a permission someone made by hand for a new source's name", async () => {
    // Performs the test.
    const engine = available[0] as EngineName;
    await database.db
      .insert(scopes)
      .values({ code: "sources.ajena.use", description: "Hecho a mano", sensitive: false });
    const saved = await saveSource(
      database.db,
      secrets,
      { code: "ajena", name: "Ajena", ...DEMO_ENGINES[engine].reader },
      1,
    );
    const [scope] = await database.db
      .select()
      .from(scopes)
      .where(eq(scopes.code, "sources.ajena.use"));

    // Performs assertions.
    expect(saved).toEqual({ saved: false });
    expect(scope?.description).toBe("Hecho a mano");
  });

  it("sends a source's published tools back to drafts when it points to another database", async () => {
    // Performs the test.
    const engine = available[0] as EngineName;
    const reader = DEMO_ENGINES[engine].reader;
    await saveSource(database.db, secrets, { code: "movida", name: "Movida", ...reader }, 1);
    const registry = new ToolRegistry(database.db);
    const created = new CreatedTools(registry, { db: database.db, secrets, appTimeZone: "UTC" });
    await saveDefinition(database.db, {
      name: "movida_pedidos",
      sourceCode: "movida",
      spec: definitionSchema.parse({
        base: { kind: "table", name: "pedidos" },
        columns: [{ name: "id" }],
        meaning,
      }),
      columns: [{ name: "id", kind: "number" }],
      userId: 1,
    });
    await database.db
      .update(toolDefinitions)
      .set({ status: "published" })
      .where(eq(toolDefinitions.name, "movida_pedidos"));
    await created.load();
    const zoneOnly = await saveSource(
      database.db,
      secrets,
      { code: "movida", name: "Movida", ...reader, timeZone: "America/Guatemala" },
      1,
    );
    const moved = await saveSource(
      database.db,
      secrets,
      { code: "movida", name: "Movida", ...reader, database: "otra" },
      1,
    );
    await created.sourceChanged("movida", moved.saved && moved.retargeted);
    const [after] = await database.db
      .select()
      .from(toolDefinitions)
      .where(eq(toolDefinitions.name, "movida_pedidos"));
    await database.db.delete(toolDefinitions).where(eq(toolDefinitions.sourceCode, "movida"));
    await deleteSource(database.db, "movida");

    // Performs assertions.
    expect(zoneOnly).toEqual({ saved: true, retargeted: false });
    expect(moved).toEqual({ saved: true, retargeted: true });
    expect(after?.status).toBe("draft");
    expect(registry.has("movida_pedidos")).toBe(false);
  });
});

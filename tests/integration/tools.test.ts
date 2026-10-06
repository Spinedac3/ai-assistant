import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import { DEMO_ENGINES } from "../../src/cli/demoEngines.js";
import { CreatedTools, findDefinition, publishDefinition } from "../../src/creator/store.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { roleScopes, roles, scopes, toolDefinitions, users } from "../../src/db/schema.js";
import { type EngineName, runQuery } from "../../src/sources/engines.js";
import { saveSource, sourceScope } from "../../src/sources/registry.js";
import { calculateTool } from "../../src/tools/native/calculate.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { Secrets } from "../../src/vault/envelope.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const PASSWORD = "tres caballos verdes";
const LIMITS = { timeoutMs: 10_000, maxRows: 10_000 };
const secrets = Secrets.fromKey(randomBytes(32));
const meaning = { definition: "Entregas por ruta.", grain: "ruta", additive: true };
const deliveries = {
  base: { kind: "table", name: "entregas" },
  columns: [{ name: "ruta" }, { name: "entregado_en" }, { name: "a_tiempo" }],
  filters: [
    { column: "ruta", op: "in" },
    { column: "entregado_en", op: "between" },
  ],
  summary: { group_by: ["ruta"], aggregates: [{ fn: "count", as: "entregas" }] },
  order_by: [{ column: "ruta", direction: "asc" }],
  meaning,
};

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

let database: DatabaseHandle;
let app: FastifyInstance;
let registry: ToolRegistry;
let adminToken: string;
let userToken: string;
let managerToken: string;
// What the fake model was asked, and what it answers next
const asked: string[] = [];
let answer: () => string = () => "{}";

/**
 * Calls the creator as a person would
 *
 * @param   method   HTTP method
 * @param   url      Path
 * @param   payload  Body
 * @param   token    Bearer token
 *
 * @return  Status and body
 */
async function api(
  method: "GET" | "PUT" | "POST" | "DELETE",
  url: string,
  payload?: object,
  token = adminToken,
) {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

  return { status: response.statusCode, body: response.json() };
}

describe("tool creator", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    // Manages tools, and reads no source's data
    const [manager] = await database.db
      .insert(roles)
      .values({ code: "gestor", description: "Gestor de herramientas" })
      .returning();
    const [manage] = await database.db.select().from(scopes).where(eq(scopes.code, "tools.manage"));
    await database.db
      .insert(roleScopes)
      .values({ roleId: manager?.id ?? 0, scopeId: manage?.id ?? 0 });
    for (const [email, role] of [
      ["admin@example.com", "admin"],
      ["ana@example.com", "user"],
      ["luis@example.com", "gestor"],
    ] as const) {
      const [roleRow] = await database.db.select().from(roles).where(eq(roles.code, role));
      await database.db.insert(users).values({
        email,
        displayName: email,
        passwordHash: await hashPassword(PASSWORD),
        primaryRoleId: roleRow?.id ?? null,
      });
    }
    for (const engine of available) {
      await saveSource(
        database.db,
        secrets,
        {
          code: `demo-${engine}`,
          name: `Demo ${engine}`,
          ...DEMO_ENGINES[engine].reader,
          timeZone: "America/Guatemala",
        },
        1,
      );
    }

    registry = new ToolRegistry(database.db);
    registry.register(calculateTool);
    const created = new CreatedTools(registry, { db: database.db, secrets, appTimeZone: "UTC" });
    app = await buildApp({
      db: database.db,
      signer: testSigner(),
      systems: new Map(),
      tools: {
        secrets,
        appTimeZone: "UTC",
        created,
        ask: async (prompt) => {
          asked.push(prompt);
          return answer();
        },
      },
    });
    const login = async (email: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { email, password: PASSWORD },
        })
      ).json().data.token as string;
    adminToken = await login("admin@example.com");
    userToken = await login("ana@example.com");
    managerToken = await login("luis@example.com");
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("saves, checks, tries, publishes and deletes a tool on every engine", async () => {
    // Performs the test.
    const outcomes: Record<string, unknown> = {};
    for (const engine of available) {
      const name = `entregas_${engine}`;
      const url = `/admin/tools/${name}`;
      const saved = await api("PUT", url, { source: `demo-${engine}`, definition: deliveries });
      const shown = await api("GET", url);
      const tried = await api("POST", `${url}/run`, { args: { ruta: ["R-Norte-1", "R-Sur-1"] } });
      const draftInRegistry = registry.has(name);
      const published = await api("POST", `${url}/publish`);
      const inRegistry = registry.has(name);
      const asUser = await registry.execute(
        name,
        { ruta: ["R-Norte-1"] },
        { userId: 2, email: "ana@example.com", scopes: new Set(["chat.use"]) },
        { origin: "chat", timeZone: "UTC" },
      );
      const listed = await api("GET", "/admin/tools");
      const deleted = await api("DELETE", url);
      outcomes[engine] = {
        saved: [
          saved.status,
          saved.body.data.status,
          saved.body.data.checks.every((c: { ok: boolean }) => c.ok),
        ],
        description: shown.body.data.description.includes("hora de America/Guatemala"),
        tried: [tried.status, tried.body.data.total_filas],
        draftInRegistry,
        published: [published.status, published.body.data.status],
        inRegistry,
        asUser: JSON.parse(asUser.text).error,
        listed: listed.body.data.some((tool: { name: string }) => tool.name === name),
        deleted: [deleted.status, registry.has(name)],
      };
    }

    // Performs assertions.
    for (const engine of available) {
      expect(outcomes[engine]).toEqual({
        saved: [200, "draft", true],
        description: true,
        tried: [200, 2],
        draftInRegistry: false,
        published: [200, "published"],
        inRegistry: true,
        asUser: "missing_scope",
        listed: true,
        deleted: [200, false],
      });
    }
  });

  it("refuses unknown columns, a bad pasted query, a native name and a source not allowed", async () => {
    // Performs the test.
    const source = `demo-${available[0]}`;
    const unknown = await api("PUT", "/admin/tools/entregas_mal", {
      source,
      definition: {
        ...deliveries,
        columns: [{ name: "ruta" }, { name: "zona" }],
        summary: undefined,
        order_by: [],
      },
    });
    const pasted = await api("PUT", "/admin/tools/entregas_mal", {
      source,
      definition: {
        ...deliveries,
        base: { kind: "query", sql: "select * from entregas order by ruta" },
      },
    });
    const native = await api("PUT", "/admin/tools/calculate", { source, definition: deliveries });
    const notAllowed = await api(
      "PUT",
      "/admin/tools/entregas_ana",
      { source, definition: deliveries },
      userToken,
    );
    const missing = await api("POST", "/admin/tools/no_existe/publish");

    // Performs assertions.
    expect(unknown.status).toBe(400);
    expect(unknown.body).toMatchObject({
      error: "unknown_columns",
      message: "La base no tiene: zona",
    });
    expect(pasted.body).toMatchObject({ error: "invalid_query" });
    expect(native.status).toBe(409);
    expect(notAllowed.status).toBe(403);
    expect(missing.status).toBe(404);
    expect(sourceScope(source)).toBe(`sources.${source}.use`);
  });

  it("turns an edited tool back into a draft until it is published again", async () => {
    // Performs the test.
    const source = `demo-${available[0]}`;
    const url = "/admin/tools/entregas_editadas";
    await api("PUT", url, { source, definition: deliveries });
    await api("POST", `${url}/publish`);
    const before = registry.has("entregas_editadas");
    const edited = await api("PUT", url, {
      source,
      definition: { ...deliveries, filters: [{ column: "ruta", op: "=" }] },
    });
    const after = registry.has("entregas_editadas");
    const moved = await api("PUT", url, {
      source: `demo-${available[1]}`,
      definition: deliveries,
    });

    // Performs assertions.
    expect(before).toBe(true);
    expect(edited.body.data.status).toBe("draft");
    expect(after).toBe(false);
    expect(moved).toMatchObject({ status: 409, body: { error: "name_taken" } });
  });

  it("keeps every tool of a source away from someone who manages tools but not that source", async () => {
    // Performs the test.
    const url = "/admin/tools/entregas_ajenas";
    await api("PUT", url, { source: `demo-${available[0]}`, definition: deliveries });
    const calls = await Promise.all([
      api("GET", url, undefined, managerToken),
      api("POST", `${url}/run`, { args: {} }, managerToken),
      api("POST", `${url}/check`, undefined, managerToken),
      api("POST", `${url}/publish`, undefined, managerToken),
      api("DELETE", url, undefined, managerToken),
    ]);
    const listed = await api("GET", "/admin/tools", undefined, managerToken);
    await api("DELETE", url);

    // Performs assertions.
    // Over a source they may not use, the tool does not exist for them
    expect(calls.map((call) => call.status)).toEqual([404, 404, 404, 404, 404]);
    expect(listed.body.data).toEqual([]);
  });

  it("tells the columns of a base before anything is saved, only over a source the person may use", async () => {
    // Performs the test.
    const source = `demo-${available[0]}`;
    const before = await api("GET", "/admin/tools");
    const table = await api("POST", "/admin/tools/describe", {
      source,
      base: { kind: "table", name: "entregas" },
    });
    const pasted = await api("POST", "/admin/tools/describe", {
      source,
      base: { kind: "query", sql: "select ruta, count(*) as total from entregas group by ruta" },
    });
    const ordered = await api("POST", "/admin/tools/describe", {
      source,
      base: { kind: "query", sql: "select * from entregas order by ruta" },
    });
    const missing = await api("POST", "/admin/tools/describe", {
      source,
      base: { kind: "table", name: "no_existe" },
    });
    const foreign = await api(
      "POST",
      "/admin/tools/describe",
      { source, base: { kind: "table", name: "entregas" } },
      managerToken,
    );
    const after = await api("GET", "/admin/tools");

    // Performs assertions.
    expect(table.body.data.columns).toEqual(
      expect.arrayContaining([
        { name: "ruta", kind: "text" },
        { name: "entregado_en", kind: "datetime" },
        { name: "a_tiempo", kind: "boolean" },
      ]),
    );
    expect(pasted.body.data.columns.map((column: { name: string }) => column.name)).toEqual([
      "ruta",
      "total",
    ]);
    expect(ordered.body).toMatchObject({ error: "invalid_query" });
    expect(missing.body).toMatchObject({ error: "base_unreadable" });
    expect(foreign.status).toBe(403);
    // Nothing was saved
    expect(after.body.data).toEqual(before.body.data);
  });

  it("never lets a new tool replace one of the same name, nor tells of one on another source", async () => {
    // Performs the test.
    const url = "/admin/tools/entregas_unicas";
    const first = await api("PUT", url, {
      source: `demo-${available[0]}`,
      definition: deliveries,
      create: true,
    });
    const again = await api("PUT", url, {
      source: `demo-${available[0]}`,
      definition: deliveries,
      create: true,
    });
    const edited = await api("PUT", url, {
      source: `demo-${available[0]}`,
      definition: deliveries,
    });
    await api("DELETE", url);

    // Performs assertions.
    expect(first.status).toBe(200);
    expect(again).toMatchObject({ status: 409, body: { error: "name_taken" } });
    expect(edited.status).toBe(200);
  });

  it("publishes only the version that was checked, never one saved in the meantime", async () => {
    // Performs the test.
    const url = "/admin/tools/entregas_carrera";
    await api("PUT", url, { source: `demo-${available[0]}`, definition: deliveries });
    const read = await findDefinition(database.db, "entregas_carrera");
    // A save lands while the checks of the version read above are running
    await database.db
      .update(toolDefinitions)
      .set({ updatedAt: new Date(Date.now() + 1_000) })
      .where(eq(toolDefinitions.name, "entregas_carrera"));
    const stale = read ? await publishDefinition(database.db, read.tool) : "sin definición";
    const current = await findDefinition(database.db, "entregas_carrera");
    const fresh = current ? await publishDefinition(database.db, current.tool) : null;
    await api("DELETE", url);

    // Performs assertions.
    expect(stale).toBeNull();
    expect(fresh?.status).toBe("published");
  });

  it("guides with real samples from the source and returns only chips that can be saved", async () => {
    // Performs the test.
    const url = "/admin/tools/entregas_guiadas";
    await api("PUT", url, { source: `demo-${available[0]}`, definition: deliveries });
    const proposed = { ...deliveries, filters: [{ column: "ruta", op: "=" }] };
    answer = () =>
      JSON.stringify({
        explanation: "Cuenta entregas por ruta.",
        chips: [
          { label: "Filtrar por una ruta", why: "Se pregunta por una ruta.", definition: proposed },
          {
            label: "Leer pedidos",
            why: "x",
            definition: { ...deliveries, base: { kind: "table", name: "pedidos" } },
          },
        ],
      });
    const guided = await api("POST", `${url}/guide`, { question: "¿Qué más le pongo?" });
    const prompt = asked.at(-1) ?? "";
    const saved = await api("PUT", url, {
      source: `demo-${available[0]}`,
      definition: guided.body.data.chips[0].definition,
    });
    answer = () => {
      throw new Error("sin conexión con el modelo");
    };
    const failed = await api("POST", `${url}/guide`, {});
    const notAllowed = await api("POST", `${url}/guide`, {}, managerToken);
    await api("DELETE", url);

    // Performs assertions.
    expect(guided.status).toBe(200);
    expect(guided.body.data.chips.map((chip: { label: string }) => chip.label)).toEqual([
      "Filtrar por una ruta",
    ]);
    expect(prompt).toMatch(/<<<SAMPLES\n.*R-[A-Za-z]+-\d.*\nSAMPLES>>>/);
    expect(prompt).toContain("¿Qué más le pongo?");
    expect(saved.status).toBe(200);
    expect(failed).toMatchObject({ status: 502, body: { error: "guide_failed" } });
    expect(notAllowed.status).toBe(404);
  });

  it("offers the tables and views each reader may read, with their comments", async () => {
    // Performs the test.
    const found: Record<string, unknown> = {};
    for (const engine of available) {
      const listed = await api("GET", `/admin/tools/relations?source=demo-${engine}`);
      const byName = new Map(
        (
          listed.body.data.relations as Array<{
            name: string;
            kind: string;
            comment: string | null;
          }>
        ).map((relation) => [relation.name, relation]),
      );
      found[engine] = {
        status: listed.status,
        view: byName.get("pedidos_con_cliente")?.kind,
        commented: byName.get("clientes")?.comment?.startsWith("Tiendas y empresas"),
        bare: byName.get("entregas")?.comment,
      };
    }
    const withoutSource = await api(
      "GET",
      `/admin/tools/relations?source=demo-${available[0]}`,
      undefined,
      managerToken,
    );

    // Performs assertions.
    for (const engine of available) {
      expect(found[engine]).toEqual({ status: 200, view: "view", commented: true, bare: null });
    }
    expect(withoutSource.status).toBe(403);
  });

  it("describes a base with the model, and still gives its columns when the model fails", async () => {
    // Performs the test.
    const body = { source: `demo-${available[0]}`, base: { kind: "table", name: "entregas" } };
    answer = () => "  Cada entrega de un pedido,\n con su ruta.  ";
    const described = await api("POST", "/admin/tools/explain", body);
    const prompt = asked.at(-1) ?? "";
    answer = () => {
      throw new Error("sin modelo");
    };
    const failed = await api("POST", "/admin/tools/explain", body);

    // Performs assertions.
    expect(described.body.data.description).toBe("Cada entrega de un pedido, con su ruta.");
    expect(prompt).toContain("<<<SAMPLES");
    expect(failed.status).toBe(200);
    expect(failed.body.data.description).toBeNull();
    expect(failed.body.data.note).toContain("escríbela tú");
    expect(failed.body.data.columns.map((column: { name: string }) => column.name)).toContain(
      "ruta",
    );
  });

  it("lists a column's few values as the only choices, and only gives examples otherwise", async () => {
    // Performs the test.
    answer = () => "Zona del cliente.";
    const help = (column: string, op: string) =>
      api("POST", "/admin/tools/filter-help", {
        source: `demo-${available[0]}`,
        base: { kind: "table", name: "pedidos_con_cliente" },
        column,
        op,
      });
    const zona = await help("zona", "=");
    const contains = await help("zona", "contains");
    const cliente = await help("cliente", "=");
    const fecha = await help("fecha", "between");
    const unknown = await help("region", "=");

    // Performs assertions.
    expect(zona.body.data).toEqual({
      values: ["Centro", "Norte", "Occidente", "Oriente", "Sur"],
      examples: null,
      description: "Zona del cliente.",
    });
    expect(contains.body.data.values).toBeNull();
    expect(contains.body.data.examples).toHaveLength(5);
    expect(cliente.body.data.values).toBeNull();
    expect(fecha.body.data).toMatchObject({ values: null, examples: null });
    expect(unknown.status).toBe(400);
  });

  it("suggests the meaning and the totals, and leaves a note when the model cannot", async () => {
    // Performs the test.
    answer = () =>
      '{"name": "ventas_por_zona", "definition": "Ventas.", "grain": "una zona", "synonyms": ["ventas"]}';
    const meaningAsked = await api("POST", "/admin/tools/suggest", {
      about: "Pedidos con su cliente.",
      columns: ["zona", "total"],
      totals: { by: ["zona"], calculations: ["ventas: suma de total"], detail: true },
    });
    answer = () =>
      JSON.stringify({
        ideas: [
          {
            label: "Ventas por zona",
            why: "Compara zonas.",
            group_by: ["zona"],
            aggregates: [{ fn: "sum", column: "total", as: "ventas" }],
          },
          {
            label: "Suma de texto",
            group_by: [],
            aggregates: [{ fn: "sum", column: "zona", as: "x" }],
          },
        ],
      });
    const totals = await api("POST", "/admin/tools/suggest-totals", {
      source: `demo-${available[0]}`,
      base: { kind: "table", name: "pedidos_con_cliente" },
    });
    answer = () => {
      throw new Error("sin modelo");
    };
    const failed = await api("POST", "/admin/tools/suggest", {
      about: "Pedidos.",
      columns: ["zona"],
    });

    // Performs assertions.
    expect(meaningAsked.body.data).toEqual({
      name: "ventas_por_zona",
      definition: "Ventas.",
      grain: "una zona",
      synonyms: ["ventas"],
    });
    expect(totals.body.data.ideas.map((idea: { label: string }) => idea.label)).toEqual([
      "Ventas por zona",
    ]);
    expect(failed.status).toBe(200);
    expect(failed.body.data).toMatchObject({ name: null, note: expect.any(String) });
  });

  it("brings totals and their detail, and saving the published version keeps it published", async () => {
    // Performs the test.
    const name = "ventas_por_zona_detalle";
    const url = `/admin/tools/${name}`;
    const definition = {
      base: { kind: "table", name: "pedidos_con_cliente" },
      columns: [{ name: "pedido_id" }, { name: "zona" }, { name: "total" }],
      filters: [{ column: "zona", op: "=", values: [{ value: "Norte" }, { value: "Sur" }] }],
      summary: {
        group_by: ["zona"],
        aggregates: [{ fn: "count", as: "pedidos" }],
        with_detail: true,
      },
      meaning: { definition: "Pedidos por zona." },
    };
    const saved = await api("PUT", url, {
      source: `demo-${available[0]}`,
      definition,
      create: true,
    });
    const run = await api("POST", `${url}/run`, { args: { zona: "Norte" } });
    await api("POST", `${url}/publish`);
    const again = await api("PUT", url, { source: `demo-${available[0]}`, definition });
    const changed = await api("PUT", url, {
      source: `demo-${available[0]}`,
      definition: { ...definition, meaning: { definition: "Pedidos de cada zona." } },
    });
    const outside = await api("POST", `${url}/run`, { args: { zona: "Antártida" } });
    await api("DELETE", url);
    const data = run.body.data;

    // Performs assertions.
    expect(saved.body.data.checks.every((check: { ok: boolean }) => check.ok)).toBe(true);
    expect(data.filas).toEqual([{ zona: "Norte", pedidos: data.total_detalle }]);
    expect(data.detalle.every((row: { zona: string }) => row.zona === "Norte")).toBe(true);
    expect(again.body.data.status).toBe("published");
    expect(changed.body.data.status).toBe("draft");
    expect(outside.body.data.error ?? outside.body.error).toBeDefined();
  });

  it("lists few values only when they are short enough to be categories", async () => {
    // Performs the test.
    answer = () => "Una nota.";
    const help = await api("POST", "/admin/tools/filter-help", {
      source: `demo-${available[0]}`,
      base: {
        kind: "query",
        sql: "select case when id < 3 then repeat('x', 70) else 'corta' end as nota from clientes",
      },
      column: "nota",
      op: "=",
    });

    // Performs assertions.
    expect(help.body.data.values).toBeNull();
    expect(help.body.data.examples).toHaveLength(2);
  });

  it("keeps every total whole when the detail behind them does not fit the answer", async () => {
    // Performs the test.
    const url = "/admin/tools/compras_por_cliente";
    await api("PUT", url, {
      source: `demo-${available[0]}`,
      create: true,
      definition: {
        base: { kind: "table", name: "pedidos_con_cliente" },
        columns: [{ name: "pedido_id" }, { name: "fecha" }, { name: "cliente" }, { name: "total" }],
        summary: {
          group_by: ["cliente"],
          aggregates: [
            { fn: "sum", column: "total", as: "comprado" },
            { fn: "count", as: "pedidos" },
          ],
          with_detail: true,
        },
        meaning: { definition: "Compras por cliente." },
      },
    });
    const run = await api("POST", `${url}/run`, { args: {} });
    await api("DELETE", url);
    const data = run.body.data;

    // Performs assertions.
    expect(data.filas).toHaveLength(data.total_filas);
    expect(data.total_filas).toBe(40);
    expect(data.detalle.length).toBeLessThan(data.total_detalle);
    expect(Object.keys(data.filas_omitidas)).toEqual(["detalle"]);
  });
});

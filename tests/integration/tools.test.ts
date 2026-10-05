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
    expect(moved).toMatchObject({ status: 409, body: { error: "source_changed" } });
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
    expect(calls.map((call) => call.status)).toEqual([403, 403, 403, 403, 403]);
    expect(listed.body.data).toEqual([]);
  });

  it("tells the columns of a base before anything is saved, only over a source the person may use", async () => {
    // Performs the test.
    const source = `demo-${available[0]}`;
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
    const listed = await api("GET", "/admin/tools");

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
    expect(listed.body.data.map((tool: { name: string }) => tool.name)).not.toContain("describe");
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
    expect(notAllowed.status).toBe(403);
  });
});

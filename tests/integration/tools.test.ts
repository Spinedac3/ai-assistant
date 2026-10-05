import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import { DEMO_ENGINES } from "../../src/cli/demoEngines.js";
import { CreatedTools } from "../../src/creator/store.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { roles, users } from "../../src/db/schema.js";
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
    for (const [email, role] of [
      ["admin@example.com", "admin"],
      ["ana@example.com", "user"],
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
      tools: { secrets, appTimeZone: "UTC", created },
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
});

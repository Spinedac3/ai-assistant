import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import { listConversations } from "../../src/chat/repository.js";
import { DEMO_ENGINES } from "../../src/cli/demoEngines.js";
import { CreatedTools, findDefinition } from "../../src/creator/store.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { conversations, rateLimits, roles, toolCalls, users } from "../../src/db/schema.js";
import { saveSource } from "../../src/sources/registry.js";
import { calculateTool } from "../../src/tools/native/calculate.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { Secrets } from "../../src/vault/envelope.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const PASSWORD = "tres caballos verdes";
const fakeCli = join(import.meta.dirname, "..", "support", "fakeCli.mjs");
const scratch = mkdtempSync(join(tmpdir(), "trial-chat-"));
const scenario = join(scratch, "scenario.json");
const secrets = Secrets.fromKey(randomBytes(32));
const deliveries = {
  base: { kind: "table", name: "entregas" },
  columns: [{ name: "ruta" }, { name: "entregado_en" }],
  filters: [{ column: "ruta", op: "in" }],
  summary: { group_by: ["ruta"], aggregates: [{ fn: "count", as: "entregas" }] },
  order_by: [{ column: "ruta", direction: "asc" }],
  meaning: { definition: "Entregas por ruta.", grain: "ruta", additive: true },
};

let database: DatabaseHandle;
let app: FastifyInstance;
let token: string;
const asked: string[] = [];
let guideAnswer: () => string = () => JSON.stringify({ explanation: "ok", chips: [] });

/**
 * Finds a free local port, so the fake CLI can reach this app's /mcp over HTTP
 *
 * @return  The port
 */
async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

/**
 * Scripts what the fake CLI does on its next runs
 *
 * @param   runs  Scripted runs
 */
function script(runs: unknown[]): void {
  writeFileSync(scenario, JSON.stringify(runs));
  rmSync(`${scenario}.count`, { force: true });
  rmSync(`${scenario}.calls`, { force: true });
}

/**
 * Reads the flags of the fake CLI's last run
 *
 * @return  The flags
 */
function lastArgs(): string[] {
  const lines = readFileSync(`${scenario}.calls`, "utf8").trim().split("\n");

  return JSON.parse(lines.at(-1) ?? "{}").args;
}

/**
 * Calls the API as the person building the tool
 *
 * @param   method   HTTP method
 * @param   url      Path
 * @param   payload  Body
 *
 * @return  Status and body
 */
async function api(method: "GET" | "PUT" | "POST", url: string, payload?: object) {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${token}` },
    ...(payload ? { payload } : {}),
  });

  return { status: response.statusCode, body: response.json() };
}

describe("trial chat", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    const [admin] = await database.db.select().from(roles).where(eq(roles.code, "admin"));
    await database.db.insert(users).values({
      email: "beto@example.com",
      displayName: "Beto Ruiz",
      passwordHash: await hashPassword(PASSWORD),
      primaryRoleId: admin?.id ?? null,
    });
    await saveSource(
      database.db,
      secrets,
      { code: "demo", name: "Demo", ...DEMO_ENGINES.postgres.reader },
      1,
    );

    const port = await freePort();
    const mcpUrl = `http://127.0.0.1:${port}/mcp`;
    const workspacesDir = join(scratch, "workspaces");
    mkdirSync(workspacesDir, { recursive: true });
    const chat = {
      cli: { bin: process.execPath, binArgs: [fakeCli, scenario] },
      model: "fake",
      workspacesDir,
      prompt: { assistantName: "Lumen", timeZone: "UTC", organizationContext: null },
      limits: { msgsPerHour: 100, msgsPerDay: 100, tokensPerDay: 1_000_000 },
    };
    const registry = new ToolRegistry(database.db);
    registry.register(calculateTool);
    const created = new CreatedTools(registry, { db: database.db, secrets, appTimeZone: "UTC" });
    app = await buildApp({
      db: database.db,
      signer: testSigner(),
      systems: new Map(),
      mcp: {
        registry,
        publicBaseUrl: "https://assistant.example.com",
        settings: {
          assistantName: "Lumen",
          organizationContext: null,
          timeZone: "UTC",
          accessContact: async () => "admin@example.com",
        },
      },
      tools: {
        secrets,
        appTimeZone: "UTC",
        created,
        trial: { chat, mcpUrl, registry },
        ask: async (prompt: string) => {
          asked.push(prompt);
          return guideAnswer();
        },
      },
    });
    await app.listen({ port, host: "127.0.0.1" });
    token = (
      await app.inject({
        method: "POST",
        url: "/auth/login",
        payload: { email: "beto@example.com", password: PASSWORD },
      })
    ).json().data.token;
    await api("PUT", "/admin/tools/entregas_prueba", { source: "demo", definition: deliveries });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
    rmSync(scratch, { recursive: true, force: true });
  });

  it("calls only the draft, directly, through the real MCP path, and shows what it got", async () => {
    // Performs the test.
    script([
      {
        steps: [
          {
            tool: "mcp__assistant__entregas_prueba",
            id: "t1",
            mcp: true,
            input: { ruta: ["R-Norte-1"] },
          },
          { text: "La ruta R-Norte-1 tiene entregas." },
        ],
        result: "La ruta R-Norte-1 tiene entregas.",
      },
    ]);
    const answered = await api("POST", "/admin/tools/entregas_prueba/chat", {
      message: "¿Cuántas entregas tiene la ruta norte 1?",
    });
    const args = lastArgs();
    const [audit] = await database.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.toolName, "entregas_prueba"));
    const trace = answered.body.data.trace[0];

    // Performs assertions.
    expect(answered.status).toBe(200);
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("mcp__assistant__entregas_prueba");
    expect(trace).toMatchObject({
      tool: "entregas_prueba",
      args: { ruta: ["R-Norte-1"] },
      ok: true,
    });
    expect(trace.result).toContain('"ruta":"R-Norte-1"');
    expect(trace.bytes).toBeGreaterThan(0);
    expect(audit?.origin).toBe("trial");
  });

  it("offers the whole catalog with the draft in it, and keeps each trial with its tool", async () => {
    // Performs the test.
    script([
      {
        steps: [
          {
            tool: "mcp__assistant__run_capability",
            id: "t2",
            mcp: true,
            input: { capability: "entregas_prueba", parameters: { ruta: ["R-Sur-1"] } },
          },
          { text: "Listo." },
        ],
        result: "Listo.",
      },
    ]);
    const first = await api("POST", "/admin/tools/entregas_prueba/chat", {
      message: "Entregas de la ruta sur 1",
      scope: "catalog",
    });
    const args = lastArgs();
    const conversation = first.body.data.conversation_id;
    script([{ steps: [{ text: "Sigo aquí." }], result: "Sigo aquí." }]);
    const second = await api("POST", "/admin/tools/entregas_prueba/chat", {
      message: "¿Y ayer?",
      conversation_id: conversation,
      scope: "catalog",
    });
    const listed = await api("GET", "/admin/tools/entregas_prueba/chats");
    const read = await api("GET", `/admin/tools/entregas_prueba/chats/${conversation}`);
    const [stored] = await database.db
      .select()
      .from(conversations)
      .where(eq(conversations.id, conversation));

    // Performs assertions.
    expect(args[args.indexOf("--allowedTools") + 1]).toContain("mcp__assistant__run_capability");
    expect(first.body.data.trace[0]).toMatchObject({ tool: "entregas_prueba", ok: true });
    expect(first.body.data.trace[0].result).toContain("R-Sur-1");
    expect(second.body.data.conversation_id).toBe(conversation);
    expect(listed.body.data.map((item: { id: number }) => item.id)).toContain(conversation);
    expect(read.body.data.map((message: { role: string }) => message.role)).toEqual([
      "user",
      "assistant",
      "user",
      "assistant",
    ]);
    expect(read.body.data[1].trace[0].tool).toBe("entregas_prueba");
    expect(stored?.toolName).toBe("entregas_prueba");
  });

  it("goes on only in a conversation of this tool, and stops at the person's quota", async () => {
    // Performs the test.
    await api("PUT", "/admin/tools/otra_prueba", { source: "demo", definition: deliveries });
    script([{ steps: [{ text: "Hola." }], result: "Hola." }]);
    const other = await api("POST", "/admin/tools/otra_prueba/chat", { message: "Hola" });
    const crossed = await api("POST", "/admin/tools/entregas_prueba/chat", {
      message: "Sigo",
      conversation_id: other.body.data.conversation_id,
    });
    const badId = await api("GET", "/admin/tools/entregas_prueba/chats/abc");
    // Every message of the hour already spent
    await database.db.update(rateLimits).set({ msgCount: 10_000 });
    const limited = await api("POST", "/admin/tools/entregas_prueba/chat", { message: "Otra" });
    const guideLimited = await api("POST", "/admin/tools/entregas_prueba/guide", {});
    await database.db.update(rateLimits).set({ msgCount: 0 });
    const [beto] = await database.db
      .select()
      .from(users)
      .where(eq(users.email, "beto@example.com"));
    const chatList = await listConversations(database.db, beto?.id ?? 0);

    // Performs assertions.
    expect(other.status).toBe(200);
    expect(crossed).toMatchObject({ status: 404, body: { error: "conversation_not_found" } });
    expect(badId.status).toBe(400);
    expect(limited).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    expect(guideLimited).toMatchObject({ status: 429, body: { error: "rate_limited" } });
    // Trials never show up among the person's chats
    expect(chatList).toEqual([]);
  });

  it("shows only the calls of the attempt that answered", async () => {
    // Performs the test.
    script([
      {
        steps: [
          {
            tool: "mcp__assistant__entregas_prueba",
            id: "t9",
            mcp: true,
            input: { ruta: ["R-Sur-2"] },
          },
        ],
        // An attempt that ends without an answer is discarded and the turn retried
        result: "",
      },
      { steps: [{ text: "No hay datos para eso." }], result: "No hay datos para eso." },
    ]);
    const answered = await api("POST", "/admin/tools/entregas_prueba/chat", {
      message: "¿Y la ruta sur 2?",
    });

    // Performs assertions.
    expect(answered.status).toBe(200);
    expect(answered.body.data.trace).toEqual([]);
  });

  it("guides with values of sparse columns and dates as the source writes them, and gives the message back when it fails", async () => {
    // Performs the test.
    const url = "/admin/tools/entregas_ralas";
    await api("PUT", url, {
      source: "demo",
      definition: {
        base: {
          kind: "query",
          sql: "select ruta, entregado_en, case when id > 400 then piloto end as piloto_tarde from entregas",
        },
        columns: [{ name: "ruta" }, { name: "entregado_en" }, { name: "piloto_tarde" }],
        meaning: { definition: "Entregas.", grain: "entrega", additive: true },
      },
    });
    guideAnswer = () => JSON.stringify({ explanation: "ok", chips: [] });
    const guided = await api("POST", `${url}/guide`, {});
    const prompt = asked.at(-1) ?? "";
    const spent = async () =>
      (await database.db.select().from(rateLimits)).map((row) => row.msgCount);
    const before = await spent();
    guideAnswer = () => "no sé";
    const failed = await api("POST", `${url}/guide`, {});
    const after = await spent();
    guideAnswer = () => JSON.stringify({ explanation: "ok", chips: [] });

    // Performs assertions.
    expect(guided.status).toBe(200);
    expect(prompt).toMatch(/"piloto_tarde":\["[A-Z][a-z]+ /);
    expect(prompt).toMatch(/"entregado_en":\["2026-\d{2}-\d{2} \d{2}:00:00"/);
    expect(failed).toMatchObject({ status: 502, body: { error: "guide_failed" } });
    expect(after).toEqual(before);
  });

  it("saves a definition with no hidden text in what models will read", async () => {
    // Performs the test.
    const saved = await api("PUT", "/admin/tools/entregas_limpias", {
      source: "demo",
      definition: {
        ...deliveries,
        meaning: { ...deliveries.meaning, caveats: ["Ojo󠄁‎ aquí"] },
      },
    });
    const stored = await findDefinition(database.db, "entregas_limpias");

    // Performs assertions.
    expect(saved.status).toBe(200);
    expect(stored?.tool.spec.meaning.caveats).toEqual(["Ojo aquí"]);
  });

  it("counts each creator suggestion as a message, gives it back when the model fails, and says when the quota ran out", async () => {
    // Performs the test.
    const spent = async () =>
      (await database.db.select().from(rateLimits)).reduce((sum, row) => sum + row.msgCount, 0);
    const suggest = () =>
      api("POST", "/admin/tools/suggest", { about: "Entregas por ruta.", columns: ["ruta"] });
    const before = await spent();
    guideAnswer = () => '{"name": "entregas_por_ruta", "synonyms": []}';
    const answered = await suggest();
    const afterAnswer = await spent();
    guideAnswer = () => {
      throw new Error("sin modelo");
    };
    const failed = await suggest();
    const afterFailure = await spent();
    await database.db.update(rateLimits).set({ msgCount: 10_000 });
    const limited = await suggest();
    await database.db.update(rateLimits).set({ msgCount: 0 });
    guideAnswer = () => JSON.stringify({ explanation: "ok", chips: [] });

    // Performs assertions.
    expect(answered.body.data.name).toBe("entregas_por_ruta");
    // One message, counted in the hour and in the day
    expect(afterAnswer).toBe(before + 2);
    expect(failed.body.data.note).toContain("complétalo tú");
    expect(afterFailure).toBe(afterAnswer);
    expect(limited.status).toBe(200);
    expect(limited.body.data.note).toBeTruthy();
    expect(limited.body.data.name).toBeNull();
  });
});

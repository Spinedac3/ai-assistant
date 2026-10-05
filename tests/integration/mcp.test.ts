import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { generateToken, hashToken } from "../../src/auth/opaqueTokens.js";
import { chatMcpConfig } from "../../src/chat/mcpConfig.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { accessTokens, mcpIntents, roles, toolCalls, users } from "../../src/db/schema.js";
import { purgeIntents } from "../../src/mcp/intents.js";
import { mintRunToken, revokeRunToken } from "../../src/mcp/runTokens.js";
import { calculateTool } from "../../src/tools/native/calculate.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

let database: DatabaseHandle;
let app: FastifyInstance;
let userId: number;

/**
 * Sends one JSON-RPC request to /mcp
 *
 * @param   token    Bearer token, if any
 * @param   method   JSON-RPC method
 * @param   params   Parameters
 * @param   headers  Extra headers
 *
 * @return  The response
 */
function rpc(
  token: string | null,
  method: string,
  params: object = {},
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });
}

/**
 * Calls a tool through MCP and returns its result
 *
 * @param   token  Bearer token
 * @param   name   Tool name
 * @param   args   Arguments
 *
 * @return  The JSON-RPC result
 */
async function call(token: string, name: string, args: object) {
  const response = await rpc(token, "tools/call", { name, arguments: args });

  return response.json().result;
}

/**
 * Issues a token as if an external client had finished the OAuth flow
 *
 * @return  The token
 */
async function externalToken(): Promise<string> {
  const token = generateToken("ast");
  await database.db.insert(accessTokens).values({
    userId,
    clientId: "mcp_test",
    accessTokenHash: hashToken(token),
    kind: "oauth",
    accessExpiresAt: sql`now() + interval '1 hour'`,
  });

  return token;
}

describe("mcp", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    const [role] = await database.db.select().from(roles).where(eq(roles.code, "user"));
    const [user] = await database.db
      .insert(users)
      .values({ email: "ana@example.com", displayName: "Ana", primaryRoleId: role?.id ?? null })
      .returning({ id: users.id });
    userId = user?.id ?? 0;

    const registry = new ToolRegistry(database.db);
    registry.register(calculateTool);
    registry.register({
      definition: {
        name: "payroll_totals",
        description: "Reads payroll totals per period. Needs the period.",
        inputSchema: { type: "object", properties: {} },
        requiredScopes: ["payroll.read"],
        readOnly: true,
      },
      execute: async () => ({ ok: true, data: { total: 1 } }),
    });
    registry.register({
      definition: {
        name: "broken_shape",
        description: "Returns orders with a declared shape it does not keep.",
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { total: { type: "number" } },
          required: ["total"],
        },
        requiredScopes: ["chat.use"],
        readOnly: true,
      },
      execute: async () => ({ ok: true, data: { count: "many" } }),
    });
    registry.register({
      definition: {
        name: "hidden_text",
        description: "Returns a note with invisible characters.",
        inputSchema: { type: "object", properties: {} },
        requiredScopes: ["chat.use"],
        readOnly: true,
      },
      execute: async () => ({ ok: true, data: { note: "ok\u{E0041}\u{E0042}visible" } }),
    });

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
          accessContact: async () => "rrhh@example.com",
        },
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("challenges a call without a token so the client can start OAuth", async () => {
    // Performs the test.
    const response = await rpc(null, "tools/list");

    // Performs assertions.
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toBe(
      'Bearer resource_metadata="https://assistant.example.com/.well-known/oauth-protected-resource"',
    );
  });

  it("refuses a browser origin it does not know", async () => {
    // Performs the test.
    const token = await externalToken();
    const response = await rpc(token, "tools/list", {}, { origin: "https://evil.example.com" });

    // Performs assertions.
    expect(response.statusCode).toBe(403);
  });

  it("offers the chat only the two meta tools and runs a capability through them", async () => {
    // Performs the test.
    const token = await mintRunToken(database.db, userId, 5, { tools: null, conversationId: 42 });
    const list = (await rpc(token, "tools/list")).json().result.tools;
    const found = await call(token, "find_capability", {
      query: "calculate arithmetic expression",
    });
    const ran = await call(token, "run_capability", {
      capability: "calculate",
      parameters: { expression: "6 * 7" },
    });
    const [row] = await database.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.conversationId, 42));

    // Performs assertions.
    expect(list.map((tool: { name: string }) => tool.name)).toEqual([
      "find_capability",
      "run_capability",
    ]);
    expect(list[0].inputSchema.properties.original_question).toBeUndefined();
    expect(JSON.parse(found.content[0].text).capabilities[0].name).toBe("calculate");
    expect(ran.isError).toBe(false);
    expect(ran.content[0].text).toContain('<tool_result name="calculate" trusted="false">');
    expect(ran.content[0].text).toContain('"result":42');
    expect(row?.origin).toBe("chat");
  });

  it("declares a capability the person cannot use, without its manual or scope", async () => {
    // Performs the test.
    const token = await mintRunToken(database.db, userId, 5, { tools: null });
    const result = await call(token, "run_capability", {
      capability: "payroll_totals",
      parameters: {},
    });
    const body = JSON.parse(result.content[0].text);

    // Performs assertions.
    expect(result.isError).toBe(true);
    expect(body.error).toBe("capability_restricted");
    expect(body.how_to_get_access).toContain("rrhh@example.com");
    expect(result.content[0].text).not.toContain("payroll.read");
  });

  it("suggests close names for a capability that does not exist", async () => {
    // Performs the test.
    const token = await mintRunToken(database.db, userId, 5, { tools: null });
    const result = await call(token, "run_capability", {
      capability: "calculator",
      parameters: {},
    });

    // Performs assertions.
    expect(JSON.parse(result.content[0].text)).toEqual(
      expect.objectContaining({
        error: "capability_not_found",
        suggestions: expect.arrayContaining(["calculate"]),
      }),
    );
  });

  it("gives an agent run its own tools, direct, with their output contract", async () => {
    // Performs the test.
    const token = await mintRunToken(database.db, userId, 5, { tools: ["calculate"] });
    const list = (await rpc(token, "tools/list")).json().result.tools;
    const result = await call(token, "calculate", { expression: "10 / 4" });
    const outside = await call(token, "hidden_text", {});

    // Performs assertions.
    expect(list.map((tool: { name: string }) => tool.name)).toEqual(["calculate"]);
    expect(list[0].outputSchema.required).toEqual(["expression", "result", "rounded"]);
    expect(result.structuredContent).toEqual({ expression: "10 / 4", result: 2.5, rounded: 2.5 });
    expect(JSON.parse(outside.content[0].text).error).toBe("tool_not_assigned");
  });

  it("fails loudly when a tool breaks its declared output shape", async () => {
    // Performs the test.
    const token = await mintRunToken(database.db, userId, 5, { tools: ["broken_shape"] });
    const result = await call(token, "broken_shape", {});

    // Performs assertions.
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("output_contract_broken");
  });

  it("strips invisible characters before a model reads a result", async () => {
    // Performs the test.
    const token = await mintRunToken(database.db, userId, 5, { tools: ["hidden_text"] });
    const result = await call(token, "hidden_text", {});

    // Performs assertions.
    expect(result.structuredContent).toEqual({ note: "okvisible" });
  });

  it("records the metadata of a call but never its result", async () => {
    // Performs the test.
    const token = await mintRunToken(database.db, userId, 5, {
      tools: ["calculate"],
      conversationId: 77,
    });
    await call(token, "calculate", { expression: "123456 + 1" });
    const [row] = await database.db
      .select()
      .from(toolCalls)
      .where(eq(toolCalls.conversationId, 77));

    // Performs assertions.
    expect(row).toEqual(
      expect.objectContaining({
        toolName: "calculate",
        argsJson: { expression: "123456 + 1" },
        success: true,
        origin: "run",
        resultBytes: expect.any(Number),
        resultHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(JSON.stringify(row)).not.toContain("123457");
  });

  it("asks external clients for the original question and keeps it only for a while", async () => {
    // Performs the test.
    const token = await externalToken();
    const list = (await rpc(token, "tools/list")).json().result.tools;
    await call(token, "run_capability", {
      capability: "calculate",
      parameters: { expression: "1 + 1" },
      original_question: "¿cuánto es uno más uno?",
    });
    const stored = await database.db.select().from(mcpIntents);
    await database.db.update(mcpIntents).set({ createdAt: sql`now() - interval '91 days'` });
    const purged = await purgeIntents(database.db, 90);

    // Performs assertions.
    expect(list[0].inputSchema.properties.original_question).toEqual(expect.any(Object));
    expect(stored.map((intent) => [intent.toolName, intent.question])).toEqual([
      ["calculate", "¿cuánto es uno más uno?"],
    ]);
    expect(purged).toBe(1);
  });

  it("rejects a revoked run token and one issued before the person's sessions were revoked", async () => {
    // Performs the test.
    const revoked = await mintRunToken(database.db, userId, 5, { tools: null });
    await revokeRunToken(database.db, revoked);
    const older = await externalToken();
    await database.db
      .update(users)
      .set({ tokensRevokedAt: sql`now() + interval '1 second'` })
      .where(eq(users.id, userId));

    // Performs assertions.
    expect((await rpc(revoked, "tools/list")).statusCode).toBe(401);
    expect((await rpc(older, "tools/list")).statusCode).toBe(401);
  });

  it("writes a per-turn config bound to the conversation and revokes it on release", async () => {
    // Performs the test.
    // The previous test revoked every session of this person
    await database.db.update(users).set({ tokensRevokedAt: null }).where(eq(users.id, userId));
    const workspace = mkdtempSync(join(tmpdir(), "mcp-config-"));
    const release = await chatMcpConfig(database.db, "http://127.0.0.1:3000/mcp")(
      workspace,
      userId,
      9,
    );
    const config = JSON.parse(readFileSync(join(workspace, ".mcp.json"), "utf8"));
    const token = String(config.mcpServers.assistant.headers.Authorization).replace("Bearer ", "");
    const during = (await rpc(token, "tools/list")).statusCode;
    await release();
    const after = (await rpc(token, "tools/list")).statusCode;

    // Performs assertions.
    expect(config.mcpServers.assistant).toEqual(
      expect.objectContaining({ type: "http", url: "http://127.0.0.1:3000/mcp", alwaysLoad: true }),
    );
    expect(during).toBe(200);
    expect(after).toBe(401);
    expect(existsSync(join(workspace, ".mcp.json"))).toBe(false);
  });

  it("revokes a token born in the same second as the revocation", async () => {
    // Performs the test.
    await database.db.update(users).set({ tokensRevokedAt: null }).where(eq(users.id, userId));
    const token = await externalToken();
    await database.db
      .update(users)
      .set({ tokensRevokedAt: sql`date_trunc('second', now())` })
      .where(eq(users.id, userId));
    const response = await rpc(token, "tools/list");

    // Performs assertions.
    expect(response.statusCode).toBe(401);
  });

  it("revokes the turn token when its config cannot be written", async () => {
    // Performs the test.
    await database.db.update(users).set({ tokensRevokedAt: null }).where(eq(users.id, userId));
    const missing = join(tmpdir(), `no-such-dir-${Date.now()}`, "nested");
    const attempt = chatMcpConfig(database.db, "http://127.0.0.1:3000/mcp")(missing, userId, 10);
    await expect(attempt).rejects.toThrow();
    const [latest] = await database.db
      .select({ kind: accessTokens.kind, revokedAt: accessTokens.revokedAt })
      .from(accessTokens)
      .orderBy(desc(accessTokens.id))
      .limit(1);

    // Performs assertions.
    expect(latest?.kind).toBe("run");
    expect(latest?.revokedAt).toEqual(expect.any(Date));
  });
});

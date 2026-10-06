import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashSecret, type MachineClient } from "../../src/auth/machineClients.js";
import { generateToken, hashToken } from "../../src/auth/opaqueTokens.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { accessTokens, auditLogs, roles, users } from "../../src/db/schema.js";
import { mintRunToken } from "../../src/mcp/runTokens.js";
import { calculateTool } from "../../src/tools/native/calculate.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const SECRET = "factory-secret-that-is-long-enough";
let database: DatabaseHandle;
let app: FastifyInstance;
let ownerId: number;
let inactiveId: number;

/**
 * Builds the Basic credentials of a machine client
 *
 * @param   clientId  Client
 * @param   secret    Its secret
 *
 * @return  The Authorization header
 */
function basic(clientId: string, secret = SECRET): string {
  return `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;
}

/**
 * Asks for a run token as the factory
 *
 * @param   payload  Body
 * @param   auth     Authorization header
 *
 * @return  The response
 */
function issue(payload: object, auth = basic("agent-factory")) {
  return app.inject({
    method: "POST",
    url: "/runs/tokens",
    headers: { authorization: auth },
    payload,
  });
}

/**
 * Lists the tools a token reaches through MCP
 *
 * @param   token  Bearer token
 *
 * @return  The status and the tool names
 */
async function toolsOf(token: string): Promise<{ status: number; names: string[] }> {
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
  const tools = response.statusCode === 200 ? response.json().result.tools : [];

  return { status: response.statusCode, names: tools.map((tool: { name: string }) => tool.name) };
}

describe("run tokens for another system", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    const [role] = await database.db.select().from(roles).where(eq(roles.code, "user"));
    const people = await database.db
      .insert(users)
      .values([
        { email: "duena@example.com", displayName: "Dueña", primaryRoleId: role?.id ?? null },
        {
          email: "baja@example.com",
          displayName: "Baja",
          primaryRoleId: role?.id ?? null,
          active: false,
        },
      ])
      .returning({ id: users.id });
    ownerId = people[0]?.id ?? 0;
    inactiveId = people[1]?.id ?? 0;

    const registry = new ToolRegistry(database.db);
    registry.register(calculateTool);
    registry.register({
      definition: {
        name: "payroll_totals",
        description: "Reads payroll totals per period.",
        inputSchema: { type: "object", properties: {} },
        requiredScopes: ["payroll.read"],
        readOnly: true,
      },
      execute: async () => ({ ok: true, data: { total: 1 } }),
    });
    const clients = new Map<string, MachineClient>(
      ["agent-factory", "other-system"].map((clientId) => [
        clientId,
        { clientId, secretHash: Buffer.from(hashSecret(SECRET), "hex") },
      ]),
    );

    app = await buildApp({
      db: database.db,
      signer: testSigner(),
      systems: new Map(),
      machineClients: clients,
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
    });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("grants only the agent's tools its owner can use now, and audits the request", async () => {
    // Performs the test.
    const response = await issue({
      owner_id: ownerId,
      tools: ["calculate", "payroll_totals", "calculate"],
      minutes: 30,
      run_id: "run-1",
    });
    const reached = await toolsOf(response.json().data.token);
    const [audit] = await database.db
      .select({ systemCode: auditLogs.systemCode, metadata: auditLogs.metadata })
      .from(auditLogs)
      .where(eq(auditLogs.eventCode, "run_token.issued"));

    // Performs assertions.
    expect(response.statusCode).toBe(201);
    expect(response.json().data).toMatchObject({
      tools: ["calculate"],
      denied: ["payroll_totals"],
      expires_in: 1800,
    });
    expect(reached).toEqual({ status: 200, names: ["calculate"] });
    expect(audit).toEqual({
      systemCode: "agent-factory",
      metadata: {
        run_id: "run-1",
        granted: ["calculate"],
        denied: ["payroll_totals"],
        minutes: 30,
      },
    });
  });

  it("refuses an unknown client, a wrong secret, a missing owner and a run of none of its tools", async () => {
    // Performs the test.
    const body = { owner_id: ownerId, tools: ["calculate"], minutes: 5, run_id: "run-2" };
    const unknown = await issue(body, basic("intruder"));
    const wrong = await issue(body, basic("agent-factory", "not-the-secret"));
    const bearer = await issue(body, "Bearer whatever");
    const inactive = await issue({ ...body, owner_id: inactiveId });
    const nothing = await issue({ ...body, tools: ["payroll_totals"] });
    const tooLong = await issue({ ...body, minutes: 61 });

    // Performs assertions.
    expect([unknown.statusCode, wrong.statusCode, bearer.statusCode]).toEqual([401, 401, 401]);
    expect(unknown.headers["www-authenticate"]).toBe('Basic realm="runs"');
    expect(inactive.json().error).toBe("owner_not_found");
    expect(nothing.statusCode).toBe(403);
    expect(nothing.json().data.denied).toEqual(["payroll_totals"]);
    expect(tooLong.statusCode).toBe(400);
  });

  it("keeps a run alive across a restart, since its tools are stored with the token", async () => {
    // Performs the test.
    const token = generateToken("ast");
    await database.db.insert(accessTokens).values({
      userId: ownerId,
      clientId: "agent-factory",
      accessTokenHash: hashToken(token),
      kind: "run",
      runTools: ["calculate"],
      accessExpiresAt: sql`now() + interval '10 minutes'`,
    });
    const forgotten = generateToken("ast");
    await database.db.insert(accessTokens).values({
      userId: ownerId,
      clientId: "internal-run",
      accessTokenHash: hashToken(forgotten),
      kind: "run",
      accessExpiresAt: sql`now() + interval '10 minutes'`,
    });

    // Performs assertions.
    expect(await toolsOf(token)).toEqual({ status: 200, names: ["calculate"] });
    expect((await toolsOf(forgotten)).status).toBe(401);
  });

  it("lets only the system that asked for a token end it", async () => {
    // Performs the test.
    const token = (
      await issue({ owner_id: ownerId, tools: ["calculate"], minutes: 5, run_id: "run-3" })
    ).json().data.token;
    const chatToken = await mintRunToken(database.db, ownerId, 5, { tools: null });
    const revoke = (value: string, auth: string) =>
      app.inject({
        method: "POST",
        url: "/runs/tokens/revoke",
        headers: { authorization: auth },
        payload: { token: value },
      });
    const byOther = await revoke(token, basic("other-system"));
    const ofTheChat = await revoke(chatToken, basic("agent-factory"));
    const byOwner = await revoke(token, basic("agent-factory"));

    // Performs assertions.
    expect(byOther.statusCode).toBe(404);
    expect(ofTheChat.statusCode).toBe(404);
    expect(byOwner.statusCode).toBe(200);
    expect((await toolsOf(token)).status).toBe(401);
    expect((await toolsOf(chatToken)).status).toBe(200);
  });
});

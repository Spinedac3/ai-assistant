import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { auditLogs, notices, roles, toolCalls, users } from "../../src/db/schema.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const PASSWORD = "tres caballos verdes";

let database: DatabaseHandle;
let app: FastifyInstance;
const tokens: Record<string, string> = {};

describe("diagnostics", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    app = await buildApp({
      db: database.db,
      signer: testSigner(),
      systems: new Map(),
      diagnostics: {
        probes: {
          "Base de datos": async () => undefined,
          Embeddings: async () => "1024 dimensiones",
          Correo: async () => {
            throw new Error("connect ECONNREFUSED");
          },
        },
      },
    });
    for (const [key, role] of [
      ["ana", "admin"],
      ["beto", "user"],
    ] as const) {
      const [roleRow] = await database.db.select().from(roles).where(eq(roles.code, role));
      await database.db.insert(users).values({
        email: `${key}@example.com`,
        displayName: key,
        passwordHash: await hashPassword(PASSWORD),
        primaryRoleId: roleRow?.id ?? null,
      });
      tokens[key] = (
        await app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { email: `${key}@example.com`, password: PASSWORD },
        })
      ).json().data.token;
    }
    await database.db.insert(auditLogs).values([
      { level: "error", eventCode: "notices.failed", message: "El aviso 3 no se pudo entregar" },
      { level: "info", eventCode: "auth.login_ok", message: "Login" },
    ]);
    const call = { userId: 1, argsJson: {}, durationMs: 10, origin: "chat" };
    await database.db.insert(toolCalls).values([
      { ...call, toolName: "ventas", success: false, errorCode: "timeout" },
      { ...call, toolName: "ventas", success: false, errorCode: "timeout" },
      { ...call, toolName: "ventas", success: true },
      {
        ...call,
        toolName: "entregas",
        success: false,
        errorCode: "invalid_arguments",
        createdAt: new Date(Date.now() - 2 * 86_400_000),
      },
    ]);
    await database.db.insert(notices).values({
      senderUserId: 1,
      key: "k",
      recipientUserId: 1,
      recipientEmail: "a@example.com",
      subject: "x",
      message: "x",
    });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("says which services answer, the latest errors, what fails and what waits, only to administrators", async () => {
    // Performs the test.
    const read = await app.inject({
      url: "/admin/diagnostics",
      headers: { authorization: `Bearer ${tokens.ana}` },
    });
    const denied = await app.inject({
      url: "/admin/diagnostics",
      headers: { authorization: `Bearer ${tokens.beto}` },
    });
    const data = read.json().data;

    // Performs assertions.
    expect(denied.statusCode).toBe(403);
    expect(data.services).toEqual([
      { name: "Base de datos", ok: true, ms: expect.any(Number), detail: null },
      { name: "Embeddings", ok: true, ms: expect.any(Number), detail: "1024 dimensiones" },
      { name: "Correo", ok: false, ms: expect.any(Number), detail: "connect ECONNREFUSED" },
    ]);
    expect(data.errors).toEqual([
      {
        event: "notices.failed",
        message: "El aviso 3 no se pudo entregar",
        at: expect.any(String),
      },
    ]);
    // Only the last day counts
    expect(data.failingTools).toEqual([{ tool: "ventas", error: "timeout", failures: 2 }]);
    expect(data.queues).toEqual({
      noticesPending: 1,
      noticesFailed: 0,
      documentsWaiting: 0,
      documentsFailed: 0,
    });
  });
});

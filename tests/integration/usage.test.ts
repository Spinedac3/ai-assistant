import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import {
  conversations,
  messageRatings,
  messages,
  roles,
  scopes,
  toolCalls,
  userExtraScopes,
  users,
} from "../../src/db/schema.js";
import { usageReport } from "../../src/usage/report.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const PASSWORD = "tres caballos verdes";
const NOW = new Date("2026-03-10T12:00:00Z");
const ZONE = "America/Guatemala";
// Hours before NOW
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

let database: DatabaseHandle;
let app: FastifyInstance;
const ids: Record<string, number> = {};

/**
 * Adds a conversation with its messages
 *
 * @param   userId    Owner
 * @param   turns     Questions with when they were asked and what the answer cost
 * @param   toolName  Tool on trial, when it is a trial
 *
 * @return  The conversation id
 */
async function converse(
  userId: number,
  turns: { at: Date; cost: number; tokens: number }[],
  toolName: string | null = null,
): Promise<number> {
  const [conversation] = await database.db
    .insert(conversations)
    .values({ userId, toolName })
    .returning({ id: conversations.id });
  const id = conversation?.id ?? 0;
  for (const turn of turns) {
    await database.db.insert(messages).values([
      { conversationId: id, role: "user", content: "secreto de la pregunta", createdAt: turn.at },
      {
        conversationId: id,
        role: "assistant",
        content: "respuesta",
        costMillionths: turn.cost,
        tokensIn: turn.tokens,
        tokensOut: 0,
        createdAt: turn.at,
      },
    ]);
  }

  return id;
}

/**
 * Adds a tool call
 *
 * @param   userId  Who called
 * @param   tool    Tool name
 * @param   origin  Path it came through
 * @param   at      When
 * @param   extra   Failure or truncation
 */
async function call(
  userId: number,
  tool: string,
  origin: string,
  at: Date,
  extra: { success?: boolean; truncated?: boolean } = {},
): Promise<void> {
  await database.db.insert(toolCalls).values({
    userId,
    toolName: tool,
    argsJson: {},
    success: extra.success ?? true,
    truncated: extra.truncated ?? false,
    durationMs: 100,
    origin,
    createdAt: at,
  });
}

describe("usage", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    const roleIds = Object.fromEntries(
      (await database.db.select({ id: roles.id, code: roles.code }).from(roles)).map((row) => [
        row.code,
        row.id,
      ]),
    );
    const people = [
      { key: "ana", role: "user" },
      { key: "beto", role: "user" },
      { key: "app", role: "user", isService: true },
      { key: "carla", role: "admin" },
      { key: "dora", role: null },
      { key: "eli", role: "user", active: false },
      { key: "fede", role: "user", deletedAt: new Date() },
    ];
    for (const person of people) {
      const [row] = await database.db
        .insert(users)
        .values({
          email: `${person.key}@example.com`,
          displayName: person.key,
          passwordHash: await hashPassword(PASSWORD),
          primaryRoleId: person.role ? roleIds[person.role] : null,
          isService: person.isService ?? false,
          active: person.active ?? true,
          deletedAt: person.deletedAt ?? null,
        })
        .returning({ id: users.id });
      ids[person.key] = row?.id ?? 0;
    }
    // Dora may chat only through an extra scope
    const [chatUse] = await database.db.select().from(scopes).where(eq(scopes.code, "chat.use"));
    await database.db
      .insert(userExtraScopes)
      .values({ userId: ids.dora ?? 0, scopeId: chatUse?.id ?? 0 });

    // Ana asks twice in the window (one of them late at night, still the 9th in Guatemala), once in
    // the window before, and once long ago; she also tries a tool she is building
    const chat = await converse(ids.ana ?? 0, [
      { at: ago(9), cost: 1_500, tokens: 100 },
      { at: ago(48), cost: 500, tokens: 50 },
      { at: ago(24 * 40), cost: 9_000, tokens: 900 },
      { at: ago(24 * 100), cost: 9_000, tokens: 900 },
    ]);
    await converse(ids.ana ?? 0, [{ at: ago(5), cost: 1_000, tokens: 10 }], "entregas");
    await call(ids.ana ?? 0, "calculate", "chat", ago(9));
    await database.db.insert(messageRatings).values([
      { messageId: chat, userId: ids.ana ?? 0, stars: 4, createdAt: ago(9) },
      { messageId: chat + 1, userId: ids.ana ?? 0, stars: 2, createdAt: ago(8) },
    ]);
    // Carla works from an external client, and an agent of hers runs once
    await call(ids.carla ?? 0, "search", "mcp", ago(2));
    await call(ids.carla ?? 0, "search", "mcp", ago(3), { success: false });
    await call(ids.carla ?? 0, "search", "mcp", ago(4), { truncated: true });
    await call(ids.carla ?? 0, "search", "run", ago(4));
    // A system with an account: one question and one call
    await converse(ids.app ?? 0, [{ at: ago(1), cost: 7_000, tokens: 700 }]);
    await call(ids.app ?? 0, "search", "mcp", ago(1));

    app = await buildApp({
      db: database.db,
      signer: testSigner(),
      systems: new Map(),
      usage: { timeZone: ZONE },
    });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("counts each channel apart, people apart from systems, and never shows what was asked", async () => {
    // Performs the test.
    const report = await usageReport(database.db, 30, ZONE, NOW);

    // Performs assertions.
    expect(report.byChannel).toEqual({ chat: 2, mcp: 3, runs: 1, trials: 1, apps: 2 });
    expect(report.totals).toEqual({
      activePeople: 2,
      questions: 2,
      mcpCalls: 3,
      costUsd: 0.003,
      tokens: 160,
    });
    expect(report.previous).toEqual({
      activePeople: 1,
      questions: 1,
      mcpCalls: 0,
      costUsd: 0.009,
      tokens: 900,
    });
    expect(report.byPerson).toEqual([
      {
        userId: ids.carla,
        name: "carla",
        email: "carla@example.com",
        role: "admin",
        questions: 0,
        mcpCalls: 3,
        toolCalls: 4,
        costUsd: 0,
        tokens: 0,
        lastActivity: ago(2).toISOString(),
      },
      {
        userId: ids.ana,
        name: "ana",
        email: "ana@example.com",
        role: "user",
        questions: 2,
        mcpCalls: 0,
        toolCalls: 1,
        costUsd: 0.003,
        tokens: 160,
        lastActivity: ago(9).toISOString(),
      },
    ]);
    expect(report.byRole).toEqual([
      { role: "admin", activePeople: 1, questions: 0, mcpCalls: 3 },
      { role: "user", activePeople: 1, questions: 2, mcpCalls: 0 },
    ]);
    expect(report.byTool).toEqual([
      { tool: "search", calls: 5, errors: 1, avgMs: 100, truncated: 1 },
      { tool: "calculate", calls: 1, errors: 0, avgMs: 100, truncated: 0 },
    ]);
    expect(report.byDay).toEqual([
      { day: "2026-03-08", questions: 1, mcpCalls: 0 },
      { day: "2026-03-09", questions: 1, mcpCalls: 0 },
      { day: "2026-03-10", questions: 0, mcpCalls: 3 },
    ]);
    expect(report.inactive.map((person) => person.name)).toEqual(["beto", "dora"]);
    expect(report.ratings).toEqual({ count: 2, averageStars: 3 });
    expect(JSON.stringify(report)).not.toContain("secreto");
  });

  it("is read only with its permission, and marks a service account only with user management", async () => {
    // Performs the test.
    const login = async (email: string) =>
      (
        await app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { email, password: PASSWORD },
        })
      ).json().data.token as string;
    const carla = { authorization: `Bearer ${await login("carla@example.com")}` };
    const ana = { authorization: `Bearer ${await login("ana@example.com")}` };
    const read = await app.inject({ url: "/admin/usage?days=7", headers: carla });
    const tooLong = await app.inject({ url: "/admin/usage?days=366", headers: carla });
    const denied = await app.inject({ url: "/admin/usage", headers: ana });
    const marked = await app.inject({
      method: "PUT",
      url: `/admin/users/${ids.beto}/service`,
      headers: carla,
      payload: { is_service: true },
    });
    const notAllowed = await app.inject({
      method: "PUT",
      url: `/admin/users/${ids.beto}/service`,
      headers: ana,
      payload: { is_service: false },
    });
    const deleted = await app.inject({
      method: "PUT",
      url: `/admin/users/${ids.fede}/service`,
      headers: carla,
      payload: { is_service: true },
    });
    const after = await usageReport(database.db, 30, ZONE, NOW);

    // Performs assertions.
    expect(read.statusCode).toBe(200);
    expect(read.json().data.period.days).toBe(7);
    expect(tooLong.statusCode).toBe(400);
    expect(denied.statusCode).toBe(403);
    expect(marked.json()).toEqual({ ok: true, data: { id: ids.beto, is_service: true } });
    expect(notAllowed.statusCode).toBe(403);
    expect(deleted.statusCode).toBe(404);
    // A system is never an inactive person
    expect(after.inactive.map((person) => person.name)).toEqual(["dora"]);
  });
});

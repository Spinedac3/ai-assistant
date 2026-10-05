import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import {
  auditLogs,
  conversations,
  messageRatings,
  messages,
  roleScopes,
  roles,
  scopes,
  toolCalls,
  userExtraScopes,
  users,
} from "../../src/db/schema.js";
import { type UsageReport, usageReport } from "../../src/usage/report.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const PASSWORD = "tres caballos verdes";
const NOW = new Date("2026-03-10T12:00:00Z");
const ZONE = "America/Guatemala";
// Hours before NOW
const ago = (hours: number) => new Date(NOW.getTime() - hours * 3_600_000);

let database: DatabaseHandle;
let app: FastifyInstance;
let empty: UsageReport;
const ids: Record<string, number> = {};

/**
 * Adds a conversation with its messages
 *
 * @param   userId    Owner
 * @param   turns     Questions with when they were asked and what the answer cost
 * @param   toolName  Tool on trial, when it is a trial
 *
 * @return  The id of the first answer
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
  const answers: number[] = [];
  for (const turn of turns) {
    const rows = await database.db
      .insert(messages)
      .values([
        {
          conversationId: conversation?.id ?? 0,
          role: "user",
          content: "secreto de la pregunta",
          createdAt: turn.at,
        },
        {
          conversationId: conversation?.id ?? 0,
          role: "assistant",
          content: "respuesta",
          costMillionths: turn.cost,
          tokensIn: turn.tokens,
          tokensOut: 0,
          createdAt: turn.at,
        },
      ])
      .returning({ id: messages.id });
    answers.push(rows[1]?.id ?? 0);
  }

  return answers[0] ?? 0;
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
    empty = await usageReport(database.db, 30, ZONE, NOW);

    const [chatUse] = await database.db.select().from(scopes).where(eq(scopes.code, "chat.use"));
    const [temporary] = await database.db
      .insert(roles)
      .values({ code: "temporal", description: "Temporal", active: false })
      .returning({ id: roles.id });
    await database.db
      .insert(roleScopes)
      .values({ roleId: temporary?.id ?? 0, scopeId: chatUse?.id ?? 0 });
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
      { key: "gabi", role: "user" },
      { key: "hugo", role: "temporal" },
      { key: "ivan", role: null },
      { key: "juan", role: null },
      { key: "viejo", role: null, isService: true, deletedAt: new Date() },
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
    // Chat through an extra scope: Dora for good, Ivan's ended before the window did, Juan's after
    await database.db.insert(userExtraScopes).values([
      { userId: ids.dora ?? 0, scopeId: chatUse?.id ?? 0 },
      { userId: ids.ivan ?? 0, scopeId: chatUse?.id ?? 0, expiresAt: new Date("2026-03-01") },
      { userId: ids.juan ?? 0, scopeId: chatUse?.id ?? 0, expiresAt: new Date("2026-04-01") },
    ]);

    // Ana asks twice in the window (one of them late at night, still the 9th in Guatemala), once in
    // the window before, and once long ago; she also tries a tool she is building
    const answer = await converse(ids.ana ?? 0, [
      { at: ago(9), cost: 1_500, tokens: 100 },
      { at: ago(48), cost: 500, tokens: 50 },
      { at: ago(24 * 40), cost: 9_000, tokens: 900 },
      { at: ago(24 * 100), cost: 9_000, tokens: 900 },
    ]);
    await converse(ids.ana ?? 0, [{ at: ago(5), cost: 1_000, tokens: 10 }], "entregas");
    await call(ids.ana ?? 0, "calculate", "chat", ago(9));
    await call(ids.ana ?? 0, "search", "trial", ago(5));
    // Gabi only builds tools: no question in the chat, but she is not inactive and she costs
    await converse(ids.gabi ?? 0, [{ at: ago(6), cost: 2_000, tokens: 20 }], "pedidos");
    await call(ids.gabi ?? 0, "search", "trial", ago(6));
    // Two people and a system use this one: still too few people to name it
    await call(ids.ana ?? 0, "fetch", "chat", ago(9));
    await call(ids.carla ?? 0, "fetch", "chat", ago(2));
    await call(ids.app ?? 0, "fetch", "chat", ago(1));
    // Carla works from an external client, and an agent of hers runs once
    await call(ids.carla ?? 0, "search", "mcp", ago(2));
    await call(ids.carla ?? 0, "search", "mcp", ago(3), { success: false });
    await call(ids.carla ?? 0, "search", "mcp", ago(4), { truncated: true });
    await call(ids.carla ?? 0, "search", "run", ago(4));
    // A system with an account: one question and one call
    const systemAnswer = await converse(ids.app ?? 0, [{ at: ago(1), cost: 7_000, tokens: 700 }]);
    // On a day of its own, which a system alone never puts in the days of people
    await call(ids.app ?? 0, "search", "mcp", ago(24 * 5));
    // A system deleted since, whose spend in the window must still show
    await converse(ids.viejo ?? 0, [{ at: ago(3), cost: 3_000, tokens: 30 }]);
    await database.db.insert(messageRatings).values([
      { messageId: answer, userId: ids.ana ?? 0, stars: 4, createdAt: ago(9) },
      { messageId: answer + 2, userId: ids.ana ?? 0, stars: 2, createdAt: ago(8) },
      { messageId: systemAnswer, userId: ids.app ?? 0, stars: 5, createdAt: ago(1) },
    ]);

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

  it("reads an empty database as zeros", () => {
    // Performs assertions.
    expect(empty.totals).toEqual({
      activePeople: 0,
      questions: 0,
      mcpCalls: 0,
      costUsd: 0,
      tokens: 0,
    });
    expect(empty.byChannel).toEqual({ chat: 0, mcp: 0, runs: 0, trials: 0, apps: 0 });
    expect(empty.byPerson).toEqual([]);
    expect(empty.byTool).toEqual([]);
    expect(empty.ratings).toEqual({ count: 0, averageStars: null });
  });

  it("counts each channel apart, people apart from systems, and never shows what was asked", async () => {
    // Performs the test.
    const report = await usageReport(database.db, 30, ZONE, NOW);

    // Performs assertions.
    expect(report.byChannel).toEqual({ chat: 2, mcp: 3, runs: 1, trials: 2, apps: 3 });
    expect(report.totals).toEqual({
      activePeople: 3,
      questions: 2,
      mcpCalls: 3,
      costUsd: 0.005,
      tokens: 180,
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
        trials: 0,
        runs: 1,
        toolCalls: 5,
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
        trials: 1,
        runs: 0,
        toolCalls: 3,
        costUsd: 0.003,
        tokens: 160,
        lastActivity: ago(5).toISOString(),
      },
      {
        userId: ids.gabi,
        name: "gabi",
        email: "gabi@example.com",
        role: "user",
        questions: 0,
        mcpCalls: 0,
        trials: 1,
        runs: 0,
        toolCalls: 1,
        costUsd: 0.002,
        tokens: 20,
        lastActivity: ago(6).toISOString(),
      },
    ]);
    // The rows of people add up to the totals; systems are listed apart with what they spent
    expect(report.byPerson.reduce((sum, person) => sum + person.tokens, 0)).toBe(
      report.totals.tokens,
    );
    expect(report.services).toEqual([
      {
        userId: ids.app,
        name: "app",
        email: "app@example.com",
        events: 2,
        costUsd: 0.007,
        tokens: 700,
      },
      {
        userId: ids.viejo,
        name: "viejo",
        email: "viejo@example.com",
        events: 1,
        costUsd: 0.003,
        tokens: 30,
      },
    ]);
    expect(report.byRole).toEqual([
      { role: "user", activePeople: 2, questions: 2, mcpCalls: 0 },
      { role: "admin", activePeople: 1, questions: 0, mcpCalls: 3 },
    ]);
    // Search was used by three people; calculate only by Ana and fetch by two people and a system,
    // so their names are not shown
    expect(report.byTool).toEqual([
      { tool: "search", calls: 7, errors: 1, avgMs: 100, truncated: 1 },
      { tool: null, calls: 4, errors: 0, avgMs: 100, truncated: 0 },
    ]);
    expect(report.byDay).toEqual([
      { day: "2026-03-08", questions: 1, mcpCalls: 0 },
      { day: "2026-03-09", questions: 1, mcpCalls: 0 },
      { day: "2026-03-10", questions: 0, mcpCalls: 3 },
    ]);
    expect(report.inactive.map((person) => person.name)).toEqual(["beto", "dora", "juan"]);
    expect(report.ratings).toEqual({ count: 2, averageStars: 3 });
    expect(JSON.stringify(report)).not.toContain("secreto");
  });

  it("is read only with its permission and leaves a record, and marks a service account only with user management", async () => {
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
    const mark = (id: unknown, isService: unknown, headers = carla) =>
      app.inject({
        method: "PUT",
        url: `/admin/users/${id}/service`,
        headers,
        payload: { is_service: isService },
      });
    const read = await app.inject({ url: "/admin/usage?days=7", headers: carla });
    const tooLong = await app.inject({ url: "/admin/usage?days=366", headers: carla });
    const denied = await app.inject({ url: "/admin/usage", headers: ana });
    const marked = await mark(ids.beto, true);
    const again = await mark(ids.beto, true);
    const notAllowed = await mark(ids.beto, false, ana);
    const deleted = await mark(ids.fede, true);
    const badId = await mark("abc", true);
    const badBody = await mark(ids.beto, "sí");
    const audits = await database.db
      .select({ code: auditLogs.eventCode, metadata: auditLogs.metadata })
      .from(auditLogs);
    const after = await usageReport(database.db, 30, ZONE, NOW);

    // Performs assertions.
    expect(read.statusCode).toBe(200);
    expect(read.json().data.period.days).toBe(7);
    expect(tooLong.statusCode).toBe(400);
    expect(denied.statusCode).toBe(403);
    expect(marked.json()).toEqual({ ok: true, data: { id: ids.beto, is_service: true } });
    expect(again.statusCode).toBe(200);
    expect(notAllowed.statusCode).toBe(403);
    expect(deleted.statusCode).toBe(404);
    expect(badId.json()).toMatchObject({ error: "invalid_id" });
    expect(badBody.json()).toMatchObject({ error: "invalid_body" });
    expect(audits.filter((row) => row.code === "usage.viewed")).toEqual([
      { code: "usage.viewed", metadata: { days: 7 } },
    ]);
    // Only the change that changed something is on record
    expect(audits.filter((row) => row.code === "users.service_changed")).toEqual([
      {
        code: "users.service_changed",
        metadata: { target: ids.beto, before: false, after: true },
      },
    ]);
    // A system is never an inactive person, and it is still in sight among the services
    expect(after.inactive.map((person) => person.name)).toEqual(["dora", "juan"]);
    expect(after.services.map((service) => service.name)).toEqual(["app", "beto", "viejo"]);
  });
});

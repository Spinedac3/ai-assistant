import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import { NO_ANSWER, NO_DATA, RETRY_DIRECTIVE } from "../../src/chat/guards.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { messages, rateLimits, roles, users } from "../../src/db/schema.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const PASSWORD = "nube-cactus-farol-29";
const fakeCli = join(import.meta.dirname, "..", "support", "fakeCli.mjs");
const scratch = mkdtempSync(join(tmpdir(), "chat-it-"));
const scenario = join(scratch, "scenario.json");

let database: DatabaseHandle;
let app: FastifyInstance;
let token: string;

interface Run {
  steps?: Array<{ text?: string; tool?: string; id?: string; ok?: boolean }>;
  context?: number;
  subtype?: string;
}

/**
 * Scripts what the fake CLI answers on each successive call
 *
 * @param   runs  One entry per CLI invocation
 */
function script(...runs: Run[]): void {
  writeFileSync(scenario, JSON.stringify(runs));
  rmSync(`${scenario}.count`, { force: true });
  rmSync(`${scenario}.calls`, { force: true });
}

/**
 * Reads how the fake CLI was called
 *
 * @return  One entry per invocation
 */
function calls(): Array<{ continued: boolean; prompt: string }> {
  const path = `${scenario}.calls`;

  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : [];
}

/**
 * Sends a chat message without streaming
 *
 * @param   content         Message
 * @param   conversationId  Conversation to continue
 *
 * @return  The response
 */
function send(content: string, conversationId?: number) {
  return app.inject({
    method: "POST",
    url: "/chat/send",
    headers: { authorization: `Bearer ${token}` },
    payload: { content, conversationId },
  });
}

describe("chat", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    const [role] = await database.db.select().from(roles).where(eq(roles.code, "user"));
    await database.db.insert(users).values({
      email: "ana@example.com",
      displayName: "Ana López",
      passwordHash: await hashPassword(PASSWORD),
      primaryRoleId: role?.id ?? null,
    });

    app = await buildApp({
      db: database.db,
      signer: testSigner(),
      systems: new Map(),
      chat: {
        cli: { bin: process.execPath, binArgs: [fakeCli, scenario] },
        model: "fake",
        workspacesDir: join(scratch, "workspaces"),
        prompt: { assistantName: "Lumen", timeZone: "UTC", organizationContext: null },
        limits: { msgsPerHour: 100, msgsPerDay: 100, tokensPerDay: 1_000_000 },
      },
    });

    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "ana@example.com", password: PASSWORD },
    });
    token = login.json().data.token;
  });

  beforeEach(async () => {
    await database.db.delete(rateLimits);
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("answers, stores the sealed answer and resumes the session on the next message", async () => {
    // Performs the test.
    script({ steps: [{ text: "Hola, ¿en qué te ayudo?" }] });
    const first = await send("hola");
    const second = await send("gracias", first.json().data.conversationId);
    const stored = await database.db
      .select()
      .from(messages)
      .where(eq(messages.id, first.json().data.assistantMessageId));

    // Performs assertions.
    expect(first.statusCode).toBe(200);
    expect(first.json().data.text).toBe(
      "Hola, ¿en qué te ayudo?\n\n_Respondido sin consultar fuentes._",
    );
    expect(stored[0]?.content).toBe(first.json().data.text);
    expect(stored[0]?.model).toBe("fake-model");
    expect(second.statusCode).toBe(200);
    expect(calls().map((call) => call.continued)).toEqual([false, true]);
  });

  it("retries a silent announcement in a fresh session with the directive", async () => {
    // Performs the test.
    script({ steps: [{ text: "Hola." }] });
    const conversation = (await send("hola")).json().data.conversationId;
    script(
      { steps: [{ text: "Déjame consultar la disponibilidad de hoy." }] },
      { steps: [{ text: "Hoy no hay pendientes." }] },
    );
    const response = await send("¿qué hay pendiente hoy?", conversation);
    const [firstCall, retry] = calls();

    // Performs assertions.
    expect(response.json().data.text).toBe(
      "Hoy no hay pendientes.\n\n_Respondido sin consultar fuentes._",
    );
    expect(firstCall?.continued).toBe(true);
    expect(retry?.continued).toBe(false);
    expect(retry?.prompt.startsWith(RETRY_DIRECTIVE)).toBe(true);
  });

  it("never stores typed tool theater, even after the retry", async () => {
    // Performs the test.
    script({ steps: [{ text: '<invoke name="run_capability">{"total": 87}</invoke>' }] });
    const response = await send("¿cuántos pedidos hay?");

    // Performs assertions.
    expect(response.json().data.text).toBe(NO_ANSWER);
    expect(calls()).toHaveLength(2);
  });

  it("answers that it could not look the data up when the figures have no source twice", async () => {
    // Performs the test.
    script({ steps: [{ text: "Hoy salieron 1,240 cajas." }] });
    const response = await send("¿cuántas cajas salieron?");

    // Performs assertions.
    expect(response.json().data.text).toBe(NO_DATA);
  });

  it("names the tools that really ran", async () => {
    // Performs the test.
    script({
      steps: [
        { tool: "mcp__assistant__run_capability", id: "t1" },
        { text: "Salieron 1,240 cajas." },
      ],
    });
    const response = await send("¿cuántas cajas salieron?");

    // Performs assertions.
    expect(response.json().data.text).toBe(
      "Salieron 1,240 cajas.\n\n_Fuentes consultadas: run capability._",
    );
    expect(response.json().data.toolCallsExecuted).toEqual(["run_capability"]);
  });

  it("starts a seeded session once the thread outgrew the context cap", async () => {
    // Performs the test.
    script({ steps: [{ text: "Primera respuesta." }], context: 160_000 });
    const conversation = (await send("primera pregunta")).json().data.conversationId;
    script({ steps: [{ text: "Segunda respuesta." }] });
    await send("segunda pregunta", conversation);
    const [call] = calls();

    // Performs assertions.
    expect(call?.continued).toBe(false);
    expect(call?.prompt).toContain("- persona: primera pregunta");
    expect(call?.prompt.endsWith("segunda pregunta")).toBe(true);
  });

  it("rejects a message once the hourly quota is used", async () => {
    // Performs the test.
    await database.db.insert(rateLimits).values({
      userId: 1,
      windowType: "hour",
      windowStart: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000),
      msgCount: 100,
    });
    const response = await send("hola");

    // Performs assertions.
    expect(response.statusCode).toBe(429);
    expect(response.json().error).toBe("rate_limited");
  });

  it("streams the turn as server-sent events", async () => {
    // Performs the test.
    script({ steps: [{ text: "Hola por stream." }] });
    const response = await app.inject({
      method: "POST",
      url: "/chat/stream",
      headers: { authorization: `Bearer ${token}` },
      payload: { content: "hola" },
    });
    const events = response.body
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("event:"))
      .map((chunk) => chunk.split("\n")[0]?.replace("event: ", ""));

    // Performs assertions.
    expect(response.headers["content-type"]).toBe("text/event-stream");
    expect(events).toEqual(["start", "delta", "done"]);
  });

  it("asks for a comment on a low rating and refuses to rate someone else's answer", async () => {
    // Performs the test.
    script({ steps: [{ text: "Hola." }] });
    const answerId = (await send("hola")).json().data.assistantMessageId;
    const rate = (id: number, payload: object) =>
      app.inject({
        method: "POST",
        url: `/chat/messages/${id}/rate`,
        headers: { authorization: `Bearer ${token}` },
        payload,
      });
    const withoutComment = await rate(answerId, { stars: 1 });
    const withComment = await rate(answerId, { stars: 1, comment: "No respondió lo que pedí" });
    const missing = await rate(999_999, { stars: 5 });

    // Performs assertions.
    expect(withoutComment.json().error).toBe("comment_required");
    expect(withComment.statusCode).toBe(200);
    expect(missing.statusCode).toBe(404);
  });
});

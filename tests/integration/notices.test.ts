import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "../../src/db/client.js";
import { auditLogs, notices, passwordResets, users } from "../../src/db/schema.js";
import { smtpMailer } from "../../src/notices/mailer.js";
import {
  deliverDue,
  enqueueNotices,
  MAX_ATTEMPTS,
  NOTICES_PER_RECIPIENT_HOUR,
  NOTICES_PER_SENDER_HOUR,
  purgeNotices,
  startNoticeWorker,
} from "../../src/notices/outbox.js";
import { sendNoticeTool } from "../../src/tools/native/sendNotice.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { freshDatabase } from "./support/database.js";
import { MAILPIT_SMTP, mailsTo } from "./support/mailpit.js";

let database: DatabaseHandle;
let senderId: number;
let anaId: number;
// Mailpit keeps what earlier runs caught, so every run writes to addresses of its own
const run = randomBytes(4).toString("hex");
const agent = `agente-${run}@example.com`;
const ana = `ana-${run}@example.com`;
const beto = `beto-${run}@example.com`;
const carla = `carla-${run}@example.com`;
const mailer = smtpMailer(MAILPIT_SMTP);
const broken = async () => {
  throw new Error("421 servicio no disponible");
};

/**
 * Makes every pending notice due now, as if its wait had passed
 */
async function makeDue(): Promise<void> {
  await database.db
    .update(notices)
    .set({ nextAttemptAt: sql`now()` })
    .where(eq(notices.status, "pending"));
}

/**
 * Reads one notice by its key
 *
 * @param   key  Key of the notice
 *
 * @return  Its status, attempts and last error
 */
async function noticeOf(key: string) {
  const [row] = await database.db
    .select({ status: notices.status, attempts: notices.attempts, lastError: notices.lastError })
    .from(notices)
    .where(eq(notices.key, key));

  return row;
}

describe("notices", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    const created = await database.db
      .insert(users)
      .values([
        { email: agent, displayName: "Agente de entregas" },
        { email: ana, displayName: "Ana" },
        { email: beto, displayName: "Beto" },
        { email: carla, displayName: "Carla" },
        { email: `ida-${run}@example.com`, displayName: "Ida", active: false },
        { email: `eli-${run}@example.com`, displayName: "Eli", deletedAt: new Date() },
      ])
      .returning({ id: users.id });
    senderId = created[0]?.id ?? 0;
    anaId = created[1]?.id ?? 0;
  });

  afterAll(async () => {
    await database.close();
  });

  it("queues only for live accounts, never twice for one key, and delivers each once naming its sender", async () => {
    // Performs the test.
    const first = await enqueueNotices(database.db, senderId, [
      { key: "tardias", to: ana.toUpperCase(), subject: "Entregas tardías", message: "Hubo 3." },
      { key: "inactiva", to: `ida-${run}@example.com`, subject: "x", message: "x" },
      { key: "borrada", to: `eli-${run}@example.com`, subject: "x", message: "x" },
      { key: "nadie", to: `nadie-${run}@example.com`, subject: "x", message: "x" },
    ]);
    const again = await enqueueNotices(database.db, senderId, [
      { key: "tardias", to: ana, subject: "Otro asunto", message: "Otro texto." },
    ]);
    const tried = await deliverDue(database.db, mailer, "Lumen");
    const triedAgain = await deliverDue(database.db, mailer, "Lumen");
    const mails = await mailsTo(ana);

    // Performs assertions.
    expect(first.map((result) => result.outcome)).toEqual([
      "queued",
      "unknown_recipient",
      "unknown_recipient",
      "unknown_recipient",
    ]);
    expect(first[0]).toEqual({ key: "tardias", to: ana.toUpperCase(), outcome: "queued" });
    expect(again.map((result) => result.outcome)).toEqual(["duplicate"]);
    expect(tried).toBe(1);
    expect(triedAgain).toBe(0);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({
      subject: "[Agente de entregas] Entregas tardías",
      text: `Aviso de Agente de entregas (${agent}), enviado por Lumen:\n\nHubo 3.`,
      replyTo: agent,
    });
  });

  it("keeps a failed notice for later, waiting longer each time, and gives up loudly at the end", async () => {
    // Performs the test.
    await enqueueNotices(database.db, senderId, [
      { key: "caido", to: beto, subject: "Servidor caído", message: "Reintenta." },
    ]);
    const waits: number[] = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      await makeDue();
      await deliverDue(database.db, broken, "Lumen");
      const [row] = await database.db
        .select({
          wait: sql<number>`round(extract(epoch from ${notices.nextAttemptAt} - now()) / 60)::int`,
        })
        .from(notices)
        .where(eq(notices.key, "caido"));
      waits.push(row?.wait ?? 0);
    }
    const afterThree = await noticeOf("caido");
    // The server comes back
    await makeDue();
    await deliverDue(database.db, mailer, "Lumen");
    const delivered = await mailsTo(beto);

    await enqueueNotices(database.db, senderId, [
      { key: "perdido", to: beto, subject: "Nunca llega", message: "x" },
    ]);
    const notAnError = async () => {
      throw "no es un Error";
    };
    for (let attempt = 0; attempt < MAX_ATTEMPTS + 2; attempt++) {
      await makeDue();
      await deliverDue(database.db, notAnError, "Lumen");
    }
    const lost = await noticeOf("perdido");
    const retried = await enqueueNotices(database.db, senderId, [
      { key: "perdido", to: beto, subject: "Nunca llega", message: "x" },
    ]);
    const audited = await database.db
      .select({ message: auditLogs.message })
      .from(auditLogs)
      .where(eq(auditLogs.eventCode, "notices.failed"));

    // Performs assertions.
    expect(waits).toEqual([1, 2, 4]);
    expect(afterThree).toMatchObject({ status: "pending", attempts: 3 });
    expect(delivered.map((mail) => mail.subject)).toEqual(["[Agente de entregas] Servidor caído"]);
    expect(lost).toEqual({ status: "failed", attempts: MAX_ATTEMPTS, lastError: "no es un Error" });
    expect(retried.map((result) => result.outcome)).toEqual(["already_failed"]);
    expect(audited.map((row) => row.message)).toEqual([
      expect.stringContaining(`tras ${MAX_ATTEMPTS} intentos: no es un Error`),
    ]);
  });

  it("sends again a notice whose send was cut off, and closes it once every attempt was cut off", async () => {
    // Performs the test.
    await enqueueNotices(database.db, senderId, [
      { key: "cortado", to: carla, subject: "Cortado", message: "x" },
      { key: "siempre-cortado", to: carla, subject: "Siempre cortado", message: "x" },
    ]);
    // A worker claimed them and died: the attempt is spent, the lease is what moved
    await database.db
      .update(notices)
      .set({ attempts: 1, nextAttemptAt: sql`now() + interval '5 minutes'` })
      .where(eq(notices.key, "cortado"));
    await database.db
      .update(notices)
      .set({ attempts: MAX_ATTEMPTS, nextAttemptAt: sql`now() + interval '5 minutes'` })
      .where(eq(notices.key, "siempre-cortado"));
    const beforeLease = await deliverDue(database.db, mailer, "Lumen");
    await database.db
      .update(notices)
      .set({ nextAttemptAt: sql`now()` })
      .where(sql`${notices.key} in ('cortado', 'siempre-cortado')`);
    const afterLease = await deliverDue(database.db, mailer, "Lumen");
    const cut = await noticeOf("cortado");
    const alwaysCut = await noticeOf("siempre-cortado");

    // Performs assertions.
    expect(beforeLease).toBe(0);
    expect(afterLease).toBe(1);
    expect(cut).toMatchObject({ status: "sent", attempts: 2 });
    expect(alwaysCut).toEqual({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      lastError: "El envío se cortó sin resultado",
    });
    expect((await mailsTo(carla)).map((mail) => mail.subject)).toEqual([
      "[Agente de entregas] Cortado",
    ]);
  });

  it("lets only the latest claim close a notice, so a slow send never undoes a newer one", async () => {
    // Performs the test.
    await enqueueNotices(database.db, senderId, [
      { key: "lento", to: carla, subject: "Lento", message: "x" },
    ]);
    // While this send hangs, its lease runs out and another worker claims the notice
    const slow = async () => {
      await database.db
        .update(notices)
        .set({ attempts: sql`${notices.attempts} + 1`, lastError: "otro worker" })
        .where(eq(notices.key, "lento"));
    };
    await deliverDue(database.db, slow, "Lumen");
    const after = await noticeOf("lento");

    // Performs assertions.
    expect(after).toEqual({ status: "pending", attempts: 2, lastError: "otro worker" });
  });

  it("sends nothing twice when two workers look at the same time, and stops between notices", async () => {
    // Performs the test.
    let sent = 0;
    const counting = async () => {
      sent++;
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    await enqueueNotices(
      database.db,
      senderId,
      [1, 2, 3].map((n) => ({ key: `par-${n}`, to: carla, subject: "x", message: "x" })),
    );
    await Promise.all([
      deliverDue(database.db, counting, "Lumen"),
      deliverDue(database.db, counting, "Lumen"),
    ]);
    await enqueueNotices(
      database.db,
      senderId,
      [1, 2].map((n) => ({ key: `alto-${n}`, to: carla, subject: "x", message: "x" })),
    );
    const afterStop = await deliverDue(database.db, counting, "Lumen", () => true);

    // Performs assertions.
    expect(sent).toBe(3);
    expect(afterStop).toBe(0);
  });

  it("stops at the hourly quota of the person who receives and of the one who sends", async () => {
    // Performs the test.
    const [received] = await database.db
      .select({ total: sql<number>`count(*)::int` })
      .from(notices)
      .where(eq(notices.recipientEmail, beto));
    const room = NOTICES_PER_RECIPIENT_HOUR - (received?.total ?? 0);
    const outcomes = await enqueueNotices(
      database.db,
      senderId,
      Array.from({ length: room + 1 }, (_, n) => ({
        key: `cuota-${n}`,
        to: beto,
        subject: "x",
        message: "x",
      })),
    );
    // Another sender fills its own hour
    const [other] = await database.db
      .insert(users)
      .values({ email: `otro-${run}@example.com`, displayName: "Otro" })
      .returning({ id: users.id });
    await database.db.insert(notices).values(
      Array.from({ length: NOTICES_PER_SENDER_HOUR }, (_, n) => ({
        senderUserId: other?.id ?? 0,
        key: `lleno-${n}`,
        recipientUserId: 0,
        recipientEmail: "x@example.com",
        subject: "x",
        message: "x",
        status: "sent" as const,
      })),
    );
    const senderFull = await enqueueNotices(database.db, other?.id ?? 0, [
      { key: "uno-mas", to: ana, subject: "x", message: "x" },
    ]);

    // Performs assertions.
    expect(outcomes.filter((result) => result.outcome === "queued")).toHaveLength(room);
    expect(outcomes.at(-1)?.outcome).toBe("over_quota");
    expect(senderFull.map((result) => result.outcome)).toEqual(["over_quota"]);
  });

  it("is a tool only for whoever may send notices, with a subject that cannot add a header", async () => {
    // Performs the test.
    const registry = new ToolRegistry(database.db);
    registry.register(sendNoticeTool(database.db));
    const call = (scopes: string[], subject: string) =>
      registry.execute(
        "send_notice",
        { notices: [{ key: `tool-${subject.length}`, to: ana, subject, message: "Hola." }] },
        { userId: senderId, email: agent, scopes: new Set(scopes) },
        { origin: "mcp", timeZone: "UTC" },
      );
    const denied = await call(["chat.use"], "Hola");
    const injected = await call(["notices.send"], "Hola\r\nBcc: todos@example.com");
    const sent = await call(["notices.send"], "Hola");

    // Performs assertions.
    expect(denied.text).toContain("missing_scope");
    expect(injected.text).toContain("invalid_arguments");
    expect(injected.text).toContain("subject");
    expect(JSON.parse(sent.text)).toMatchObject({
      notices: [{ to: ana, outcome: "queued" }],
      queued: 1,
    });
  });

  it("delivers in the background on its own and stops when asked", async () => {
    // Performs the test.
    await enqueueNotices(database.db, senderId, [
      { key: "fondo", to: ana, subject: "En segundo plano", message: "Llegó solo." },
    ]);
    const errors: unknown[] = [];
    const stop = startNoticeWorker({
      db: database.db,
      send: mailer,
      assistantName: "Lumen",
      logger: { error: (object) => errors.push(object) },
      pollMs: 20,
    });
    for (let wait = 0; wait < 100 && (await noticeOf("fondo"))?.status !== "sent"; wait++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await stop();
    const mails = await mailsTo(ana);

    // Performs assertions.
    expect(mails.map((mail) => mail.subject)).toContain("[Agente de entregas] En segundo plano");
    expect(errors).toEqual([]);
  });

  it("drops old sent and failed notices and spent reset links, and keeps what may still be used", async () => {
    // Performs the test.
    await enqueueNotices(database.db, senderId, [
      { key: "pendiente-viejo", to: carla, subject: "x", message: "x" },
    ]);
    await database.db
      .update(notices)
      .set({ createdAt: sql`now() - interval '31 days'` })
      .where(sql`${notices.key} in ('tardias', 'perdido', 'pendiente-viejo')`);
    await database.db.insert(passwordResets).values([
      {
        userId: anaId,
        tokenHash: "a".repeat(64),
        expiresAt: sql`now() - interval '1 minute'`,
        createdBy: senderId,
      },
      {
        userId: anaId,
        tokenHash: "b".repeat(64),
        expiresAt: sql`now() + interval '1 hour'`,
        createdBy: senderId,
      },
    ]);
    await purgeNotices(database.db);
    const left = await database.db
      .select({ key: notices.key })
      .from(notices)
      .where(sql`${notices.key} in ('tardias', 'perdido', 'caido', 'pendiente-viejo')`);
    const links = await database.db.select({ hash: passwordResets.tokenHash }).from(passwordResets);

    // Performs assertions.
    expect(left.map((row) => row.key).sort()).toEqual(["caido", "pendiente-viejo"]);
    expect(links.map((row) => row.hash)).toEqual(["b".repeat(64)]);
  });
});

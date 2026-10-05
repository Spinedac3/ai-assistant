import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "../../src/db/client.js";
import { auditLogs, notices, users } from "../../src/db/schema.js";
import { smtpMailer } from "../../src/notices/mailer.js";
import {
  deliverDue,
  enqueueNotices,
  MAX_ATTEMPTS,
  NOTICES_PER_RECIPIENT_HOUR,
  startNoticeWorker,
} from "../../src/notices/outbox.js";
import { sendNoticeTool } from "../../src/tools/native/sendNotice.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { freshDatabase } from "./support/database.js";
import { MAILPIT_SMTP, mailsTo } from "./support/mailpit.js";

let database: DatabaseHandle;
let senderId: number;
// Mailpit keeps what earlier runs caught, so every run writes to addresses of its own
const run = randomBytes(4).toString("hex");
const ana = `ana-${run}@example.com`;
const beto = `beto-${run}@example.com`;
const gone = `gone-${run}@example.com`;
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

describe("notices", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    const created = await database.db
      .insert(users)
      .values([
        { email: `agente-${run}@example.com`, displayName: "Agente de entregas" },
        { email: ana, displayName: "Ana" },
        { email: beto, displayName: "Beto" },
        { email: gone, displayName: "Ida", active: false },
      ])
      .returning({ id: users.id });
    senderId = created[0]?.id ?? 0;
  });

  afterAll(async () => {
    await database.close();
  });

  it("queues only for active accounts, never twice for one key, and delivers each once", async () => {
    // Performs the test.
    const first = await enqueueNotices(database.db, senderId, [
      {
        key: "tardias:2026-10-05",
        to: ana.toUpperCase(),
        subject: "Entregas tardías",
        message: "Hubo 3.",
      },
      { key: "tardias:2026-10-05:ida", to: gone, subject: "x", message: "x" },
      {
        key: "tardias:2026-10-05:nadie",
        to: `nadie-${run}@example.com`,
        subject: "x",
        message: "x",
      },
    ]);
    const again = await enqueueNotices(database.db, senderId, [
      { key: "tardias:2026-10-05", to: ana, subject: "Otro asunto", message: "Otro texto." },
    ]);
    const tried = await deliverDue(database.db, mailer, "Lumen");
    const triedAgain = await deliverDue(database.db, mailer, "Lumen");
    const mails = await mailsTo(ana);

    // Performs assertions.
    expect(first).toEqual(["queued", "unknown_recipient", "unknown_recipient"]);
    expect(again).toEqual(["duplicate"]);
    expect(tried).toBe(1);
    expect(triedAgain).toBe(0);
    expect(mails).toHaveLength(1);
    expect(mails[0]?.subject).toBe("Entregas tardías");
    expect(mails[0]?.text).toBe(
      "Hubo 3.\n\n—\nAviso enviado por Lumen a pedido de Agente de entregas.",
    );
  });

  it("keeps a failed notice for later, waiting longer each time, and gives up loudly at the end", async () => {
    // Performs the test.
    await enqueueNotices(database.db, senderId, [
      { key: "caido", to: beto, subject: "Servidor caído", message: "Reintenta." },
    ]);
    await deliverDue(database.db, broken, "Lumen");
    const [afterOne] = await database.db
      .select({
        status: notices.status,
        attempts: notices.attempts,
        waitSeconds: sql<number>`extract(epoch from ${notices.nextAttemptAt} - now())::int`,
      })
      .from(notices)
      .where(eq(notices.key, "caido"));
    // The server comes back on the second try
    await makeDue();
    await deliverDue(database.db, mailer, "Lumen");
    const delivered = await mailsTo(beto);

    await enqueueNotices(database.db, senderId, [
      { key: "perdido", to: beto, subject: "Nunca llega", message: "x" },
    ]);
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      await makeDue();
      await deliverDue(database.db, broken, "Lumen");
    }
    const [lost] = await database.db
      .select({ status: notices.status, attempts: notices.attempts, lastError: notices.lastError })
      .from(notices)
      .where(eq(notices.key, "perdido"));
    const audited = await database.db
      .select({ message: auditLogs.message })
      .from(auditLogs)
      .where(eq(auditLogs.eventCode, "notices.failed"));

    // Performs assertions.
    expect(afterOne).toMatchObject({ status: "pending", attempts: 1 });
    expect(afterOne?.waitSeconds).toBeGreaterThan(50);
    expect(afterOne?.waitSeconds).toBeLessThanOrEqual(60);
    expect(delivered.map((mail) => mail.subject)).toEqual(["Servidor caído"]);
    expect(lost).toEqual({
      status: "failed",
      attempts: MAX_ATTEMPTS,
      lastError: "421 servicio no disponible",
    });
    expect(audited).toHaveLength(1);
    expect(audited[0]?.message).toContain("421 servicio no disponible");
  });

  it("sends nothing twice when two workers look at the same time", async () => {
    // Performs the test.
    let sent = 0;
    const counting = async () => {
      sent++;
      await new Promise((resolve) => setTimeout(resolve, 50));
    };
    await enqueueNotices(
      database.db,
      senderId,
      [1, 2, 3].map((n) => ({ key: `par-${n}`, to: beto, subject: "x", message: "x" })),
    );
    await Promise.all([
      deliverDue(database.db, counting, "Lumen"),
      deliverDue(database.db, counting, "Lumen"),
    ]);

    // Performs assertions.
    expect(sent).toBe(3);
  });

  it("stops at the hourly quota of the person who receives", async () => {
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

    // Performs assertions.
    expect(outcomes.filter((outcome) => outcome === "queued")).toHaveLength(room);
    expect(outcomes.at(-1)).toBe("over_quota");
  });

  it("is a tool only for whoever may send notices, with a subject that cannot add a header", async () => {
    // Performs the test.
    const registry = new ToolRegistry(database.db);
    registry.register(sendNoticeTool(database.db));
    const call = (scopes: string[], subject: string) =>
      registry.execute(
        "send_notice",
        { notices: [{ key: `tool-${subject.length}`, to: ana, subject, message: "Hola." }] },
        { userId: senderId, email: "agente@example.com", scopes: new Set(scopes) },
        { origin: "mcp", timeZone: "UTC" },
      );
    const denied = await call(["chat.use"], "Hola");
    const injected = await call(["notices.send"], "Hola\r\nBcc: todos@example.com");
    const sent = await call(["notices.send"], "Hola");

    // Performs assertions.
    expect(denied.text).toContain("permiso");
    expect(injected.text).not.toContain('"queued"');
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
    for (let wait = 0; wait < 100; wait++) {
      const [row] = await database.db
        .select({ status: notices.status })
        .from(notices)
        .where(eq(notices.key, "fondo"));
      if (row?.status === "sent") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await stop();
    const mails = await mailsTo(ana);

    // Performs assertions.
    expect(mails.map((mail) => mail.subject)).toContain("En segundo plano");
    expect(errors).toEqual([]);
  });
});

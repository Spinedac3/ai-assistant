import { and, count, eq, gte, sql } from "drizzle-orm";
import { logAudit } from "../audit.js";
import type { Database } from "../db/client.js";
import { notices, users } from "../db/schema.js";
import type { SendMail } from "./mailer.js";

export interface NoticeRequest {
  key: string;
  to: string;
  subject: string;
  message: string;
}

export type NoticeOutcome = "queued" | "duplicate" | "unknown_recipient" | "over_quota";

// Notices one person may receive in an hour, from every sender together: a broken agent stops
// here instead of flooding someone's inbox
export const NOTICES_PER_RECIPIENT_HOUR = 25;

// Attempts before a notice is given up; with the waits below they span about four hours
export const MAX_ATTEMPTS = 8;
const MAX_WAIT_MINUTES = 360;
// A claimed notice that never got an outcome (the process died mid-send) is tried again after this
const CLAIM_LEASE = "5 minutes";
const BATCH = 10;

/**
 * Queues notices for delivery, each one to an active account of the assistant
 *
 * @param   db        Own database
 * @param   senderId  Who sends them
 * @param   requests  Notices, each with the sender's key
 *
 * @return  What happened to each one, in the same order
 */
export async function enqueueNotices(
  db: Database,
  senderId: number,
  requests: NoticeRequest[],
): Promise<NoticeOutcome[]> {
  const outcomes: NoticeOutcome[] = [];
  for (const request of requests) {
    const [repeated] = await db
      .select({ id: notices.id })
      .from(notices)
      .where(and(eq(notices.senderUserId, senderId), eq(notices.key, request.key)));
    if (repeated) {
      outcomes.push("duplicate");
      continue;
    }

    const [recipient] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(sql`lower(${users.email}) = lower(${request.to})`, eq(users.active, true)));
    if (!recipient) {
      outcomes.push("unknown_recipient");
      continue;
    }

    // ponytail: count then insert can let a parallel sender through by one; a lock per recipient
    // only if that ever matters
    const [received] = await db
      .select({ total: count() })
      .from(notices)
      .where(
        and(
          eq(notices.recipientUserId, recipient.id),
          gte(notices.createdAt, sql`now() - interval '1 hour'`),
        ),
      );
    if ((received?.total ?? 0) >= NOTICES_PER_RECIPIENT_HOUR) {
      outcomes.push("over_quota");
      continue;
    }

    const inserted = await db
      .insert(notices)
      .values({
        senderUserId: senderId,
        key: request.key,
        recipientUserId: recipient.id,
        recipientEmail: recipient.email,
        subject: request.subject,
        message: request.message,
      })
      .onConflictDoNothing()
      .returning({ id: notices.id });
    outcomes.push(inserted.length > 0 ? "queued" : "duplicate");
  }

  return outcomes;
}

/**
 * Minutes to wait before the next try of a notice that failed
 *
 * @param   attempts  Tries made so far
 *
 * @return  1, 2, 4… minutes, up to six hours
 */
export function waitMinutes(attempts: number): number {
  return Math.min(2 ** Math.max(attempts - 1, 0), MAX_WAIT_MINUTES);
}

/**
 * Sends the notices that are due; a failure waits longer each time and, past the last attempt,
 * the notice is given up and audited
 *
 * @param   db             Own database
 * @param   send           Mail sender
 * @param   assistantName  Name that signs the mail
 *
 * @return  How many notices were tried
 */
export async function deliverDue(
  db: Database,
  send: SendMail,
  assistantName: string,
): Promise<number> {
  // The claim moves the next try ahead, so another worker skips these and a crash retries them
  const claimed = await db.execute(sql`
    update notices set attempts = attempts + 1, next_attempt_at = now() + interval '${sql.raw(CLAIM_LEASE)}'
    where id in (
      select id from notices where status = 'pending' and next_attempt_at <= now()
      order by next_attempt_at, id limit ${BATCH} for update skip locked
    )
    returning id, sender_user_id, recipient_email, subject, message, attempts`);
  const rows = claimed.rows as {
    id: number;
    sender_user_id: number;
    recipient_email: string;
    subject: string;
    message: string;
    attempts: number;
  }[];

  for (const row of rows) {
    const [sender] = await db
      .select({ name: users.displayName })
      .from(users)
      .where(eq(users.id, row.sender_user_id));
    try {
      await send({
        to: row.recipient_email,
        subject: row.subject,
        text: `${row.message}\n\n—\nAviso enviado por ${assistantName} a pedido de ${sender?.name ?? "una cuenta borrada"}.`,
      });
      await db
        .update(notices)
        .set({ status: "sent", sentAt: new Date(), lastError: null })
        .where(eq(notices.id, row.id));
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      const exhausted = row.attempts >= MAX_ATTEMPTS;
      await db
        .update(notices)
        .set({
          status: exhausted ? "failed" : "pending",
          lastError: message,
          nextAttemptAt: sql`now() + make_interval(mins => ${waitMinutes(row.attempts)})`,
        })
        .where(eq(notices.id, row.id));
      if (exhausted) {
        await logAudit(db, {
          userId: row.sender_user_id,
          level: "error",
          eventCode: "notices.failed",
          message: `El aviso ${row.id} no se pudo entregar tras ${row.attempts} intentos: ${message}`,
        });
      }
    }
  }

  return rows.length;
}

export interface NoticeWorker {
  db: Database;
  send: SendMail;
  assistantName: string;
  logger: { error: (object: unknown, message: string) => void };
  pollMs: number;
}

/**
 * Starts delivering due notices on a timer, until stopped
 *
 * @param   worker  Database, sender, signature, logger and how often to look
 *
 * @return  A function that stops it after the round in progress
 */
export function startNoticeWorker(worker: NoticeWorker): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let round: Promise<void> = Promise.resolve();

  const run = async () => {
    try {
      // A full batch means more may be due; keep going until the queue is drained
      while (
        !stopped &&
        (await deliverDue(worker.db, worker.send, worker.assistantName)) === BATCH
      ) {}
    } catch (error) {
      worker.logger.error({ err: error }, "notice delivery failed");
    }
    if (!stopped) {
      timer = setTimeout(() => {
        round = run();
      }, worker.pollMs);
      timer.unref();
    }
  };
  round = run();

  return async () => {
    stopped = true;
    clearTimeout(timer);
    await round;
  };
}

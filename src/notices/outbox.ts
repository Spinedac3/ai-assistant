import { and, count, eq, gte, isNull, lt, or, sql } from "drizzle-orm";
import { logAudit } from "../audit.js";
import type { Database } from "../db/client.js";
import { notices, passwordResets, users } from "../db/schema.js";
import type { SendMail } from "./mailer.js";

export interface NoticeRequest {
  key: string;
  to: string;
  subject: string;
  message: string;
}

export type NoticeOutcome =
  | "queued"
  | "duplicate"
  | "already_failed"
  | "unknown_recipient"
  | "over_quota";

export interface NoticeResult {
  key: string;
  to: string;
  outcome: NoticeOutcome;
}

// Notices one person may receive in an hour, from every sender together: a broken agent stops
// here instead of flooding someone's inbox. Counted when queued, delivered or not
export const NOTICES_PER_RECIPIENT_HOUR = 25;
// Notices one sender may queue in an hour, so one account cannot get the mail server blocked
export const NOTICES_PER_SENDER_HOUR = 300;

// Attempts before a notice is given up; waiting 1, 2, 4… minutes they span about four hours
export const MAX_ATTEMPTS = 9;
// Longer than the slowest single send (three SMTP timeouts); a notice claimed and never resolved,
// because the process died mid-send, is tried again after it
const CLAIM_LEASE_MINUTES = 5;
// Namespace of the advisory locks that serialize the quota of each recipient
const RECIPIENT_LOCK = 7_401;
// Sent and failed notices are kept this long, then dropped with their text
const KEEP_DAYS = 30;

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
): Promise<NoticeResult[]> {
  const results: NoticeResult[] = [];
  const result = (request: NoticeRequest, outcome: NoticeOutcome) =>
    results.push({ key: request.key, to: request.to, outcome });

  for (const request of requests) {
    const [repeated] = await db
      .select({ status: notices.status })
      .from(notices)
      .where(and(eq(notices.senderUserId, senderId), eq(notices.key, request.key)));
    if (repeated) {
      // A key stays used; the sender learns its notice never arrived and sends it with a new key
      result(request, repeated.status === "failed" ? "already_failed" : "duplicate");
      continue;
    }

    const [recipient] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(
        and(
          sql`lower(${users.email}) = lower(${request.to})`,
          eq(users.active, true),
          isNull(users.deletedAt),
        ),
      );
    if (!recipient) {
      result(request, "unknown_recipient");
      continue;
    }

    const outcome = await db.transaction(async (tx) => {
      // Parallel senders to one person wait here, so the count below is the real one
      await tx.execute(sql`select pg_advisory_xact_lock(${RECIPIENT_LOCK}, ${recipient.id})`);
      const hour = sql`now() - interval '1 hour'`;
      const [received] = await tx
        .select({ total: count() })
        .from(notices)
        .where(and(eq(notices.recipientUserId, recipient.id), gte(notices.createdAt, hour)));
      // ponytail: parallel calls of one sender can pass this by their number; a lock per sender
      // if that ever matters
      const [sent] = await tx
        .select({ total: count() })
        .from(notices)
        .where(and(eq(notices.senderUserId, senderId), gte(notices.createdAt, hour)));
      if (
        (received?.total ?? 0) >= NOTICES_PER_RECIPIENT_HOUR ||
        (sent?.total ?? 0) >= NOTICES_PER_SENDER_HOUR
      ) {
        return "over_quota" as const;
      }

      const inserted = await tx
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

      return inserted.length > 0 ? ("queued" as const) : ("duplicate" as const);
    });
    result(request, outcome);
  }

  return results;
}

/**
 * Minutes to wait before the next try of a notice that failed
 *
 * @param   attempts  Tries made so far
 *
 * @return  1, 2, 4… minutes
 */
export function waitMinutes(attempts: number): number {
  return 2 ** Math.max(attempts - 1, 0);
}

/**
 * Closes the notices whose every attempt was spent without an outcome, since the process died
 * while sending them
 *
 * @param   db  Own database
 */
async function closeAbandoned(db: Database): Promise<void> {
  const closed = await db
    .update(notices)
    .set({
      status: "failed",
      lastError: sql`coalesce(${notices.lastError}, 'El envío se cortó sin resultado')`,
    })
    .where(
      and(
        eq(notices.status, "pending"),
        gte(notices.attempts, MAX_ATTEMPTS),
        sql`${notices.nextAttemptAt} <= now()`,
      ),
    )
    .returning({ id: notices.id, senderUserId: notices.senderUserId });
  for (const notice of closed) {
    await logAudit(db, {
      userId: notice.senderUserId,
      level: "error",
      eventCode: "notices.failed",
      message: `El aviso ${notice.id} se cortó en cada uno de sus ${MAX_ATTEMPTS} intentos`,
    });
  }
}

/**
 * Sends the next due notice; a failure waits longer each time and, past the last attempt, the
 * notice is given up and audited
 *
 * @param   db             Own database
 * @param   send           Mail sender
 * @param   assistantName  Name of the assistant, written in the mail
 *
 * @return  Whether there was a notice to send
 */
async function deliverNext(db: Database, send: SendMail, assistantName: string): Promise<boolean> {
  // One at a time, so the lease covers a single send however slow the server is; the claim moves
  // the next try ahead, so another worker skips it and a crash retries it
  const claimed = await db.execute(sql`
    update notices set attempts = attempts + 1,
      next_attempt_at = now() + make_interval(mins => ${CLAIM_LEASE_MINUTES})
    where id = (
      select id from notices
      where status = 'pending' and next_attempt_at <= now() and attempts < ${MAX_ATTEMPTS}
      order by next_attempt_at, id limit 1 for update skip locked
    )
    returning id, sender_user_id, recipient_email, subject, message, attempts`);
  const row = claimed.rows[0] as
    | {
        id: number;
        sender_user_id: number;
        recipient_email: string;
        subject: string;
        message: string;
        attempts: number;
      }
    | undefined;
  if (!row) {
    return false;
  }

  // Only the claim that took it may close it; a stale one finds the attempts moved on
  const own = and(
    eq(notices.id, row.id),
    eq(notices.attempts, row.attempts),
    eq(notices.status, "pending"),
  );
  const [sender] = await db
    .select({ name: users.displayName, email: users.email })
    .from(users)
    .where(eq(users.id, row.sender_user_id));
  // Who sends comes first and in the subject, written by the server: the text is the sender's, so
  // it must never pass for a mail of the assistant itself
  const name = sender?.name ?? "una cuenta borrada";
  let failure: string | null = null;
  try {
    await send({
      to: row.recipient_email,
      subject: `[${name}] ${row.subject}`,
      text: `Aviso de ${name}${sender ? ` (${sender.email})` : ""}, enviado por ${assistantName}:\n\n${row.message}`,
      replyTo: sender?.email,
    });
  } catch (error) {
    failure = String(error instanceof Error ? error.message : error).slice(0, 500);
  }

  if (failure === null) {
    await db
      .update(notices)
      .set({ status: "sent", sentAt: sql`now()`, lastError: null })
      .where(own);
    return true;
  }

  const exhausted = row.attempts >= MAX_ATTEMPTS;
  await db
    .update(notices)
    .set({
      status: exhausted ? "failed" : "pending",
      lastError: failure,
      nextAttemptAt: sql`now() + make_interval(mins => ${waitMinutes(row.attempts)})`,
    })
    .where(own);
  if (exhausted) {
    await logAudit(db, {
      userId: row.sender_user_id,
      level: "error",
      eventCode: "notices.failed",
      message: `El aviso ${row.id} no se pudo entregar tras ${row.attempts} intentos: ${failure}`,
    });
  }

  return true;
}

/**
 * Sends every notice that is due, one by one, until none is left or it is told to stop
 *
 * @param   db             Own database
 * @param   send           Mail sender
 * @param   assistantName  Name of the assistant, written in the mail
 * @param   stop           Asked before each notice
 *
 * @return  How many notices were tried
 */
export async function deliverDue(
  db: Database,
  send: SendMail,
  assistantName: string,
  stop: () => boolean = () => false,
): Promise<number> {
  await closeAbandoned(db);
  let tried = 0;
  while (!stop() && (await deliverNext(db, send, assistantName))) {
    tried++;
  }

  return tried;
}

/**
 * Drops sent and failed notices past their keeping time, and reset links already of no use
 *
 * @param   db  Own database
 */
export async function purgeNotices(db: Database): Promise<void> {
  const keep = sql`now() - make_interval(days => ${KEEP_DAYS})`;
  await db
    .delete(notices)
    .where(
      and(
        or(eq(notices.status, "sent"), eq(notices.status, "failed")),
        lt(notices.createdAt, keep),
      ),
    );
  await db.delete(passwordResets).where(lt(passwordResets.expiresAt, sql`now()`));
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
 * @param   worker  Database, sender, assistant name, logger and how often to look
 *
 * @return  A function that stops it after the notice in progress
 */
export function startNoticeWorker(worker: NoticeWorker): () => Promise<void> {
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let round: Promise<void> = Promise.resolve();

  const run = async () => {
    try {
      await deliverDue(worker.db, worker.send, worker.assistantName, () => stopped);
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

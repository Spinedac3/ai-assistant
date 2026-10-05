import { and, eq, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { rateLimits } from "../db/schema.js";

export interface RateLimits {
  msgsPerHour: number;
  msgsPerDay: number;
  tokensPerDay: number;
}

export class RateLimitExceededError extends Error {
  /**
   * Builds the rejection of a message over the user's quota
   *
   * @param   window  Window that ran out
   * @param   kind    What ran out
   */
  constructor(
    public readonly window: "hour" | "day",
    public readonly kind: "messages" | "tokens",
  ) {
    super(
      window === "hour"
        ? "Llegaste al límite de mensajes de esta hora. Intenta de nuevo en un rato."
        : "Llegaste al límite de uso de hoy. Mañana se renueva.",
    );
    this.name = "RateLimitExceededError";
  }
}

/**
 * Gives the start of the current hour or day in the application's time zone
 *
 * @param   window    Hour or day
 * @param   timeZone  IANA zone where the day starts
 *
 * @return  SQL for the window start
 */
function windowStart(window: "hour" | "day", timeZone: string) {
  // The day must start at local midnight, not at midnight UTC
  return sql`date_trunc(${window}, now() at time zone ${timeZone}) at time zone ${timeZone}`;
}

/**
 * Adds to the user's hour and day counters in one statement and returns them
 *
 * @param   db              Own database
 * @param   userId          Person
 * @param   timeZone        Application time zone
 * @param   messages        Messages to add, negative to give one back
 * @param   tokens          Tokens to add
 * @param   costMillionths  Cost to add
 *
 * @return  The counters of each window after adding
 */
async function bump(
  db: Database,
  userId: number,
  timeZone: string,
  messages: number,
  tokens: number,
  costMillionths: number,
) {
  const rows = await db
    .insert(rateLimits)
    .values(
      (["hour", "day"] as const).map((window) => ({
        userId,
        windowType: window,
        windowStart: windowStart(window, timeZone),
        msgCount: Math.max(messages, 0),
        tokensUsed: tokens,
        costMillionths,
      })),
    )
    .onConflictDoUpdate({
      target: [rateLimits.userId, rateLimits.windowType, rateLimits.windowStart],
      set: {
        msgCount: sql`greatest(${rateLimits.msgCount} + ${messages}, 0)`,
        tokensUsed: sql`${rateLimits.tokensUsed} + ${tokens}`,
        costMillionths: sql`${rateLimits.costMillionths} + ${costMillionths}`,
      },
    })
    .returning({ windowType: rateLimits.windowType, msgCount: rateLimits.msgCount });

  return {
    hour: rows.find((row) => row.windowType === "hour")?.msgCount ?? 0,
    day: rows.find((row) => row.windowType === "day")?.msgCount ?? 0,
  };
}

/**
 * Counts a new message, rejecting it without counting when the user is already over a quota
 *
 * The check before counting keeps rejected messages out of the counters; the check after counting
 * is atomic, so parallel messages cannot all take the same last unit.
 *
 * @param   db        Own database
 * @param   userId    Person sending
 * @param   limits    Quotas
 * @param   timeZone  Application time zone
 *
 * @throws  RateLimitExceededError
 */
export async function reserveMessage(
  db: Database,
  userId: number,
  limits: RateLimits,
  timeZone: string,
): Promise<void> {
  const current = await db
    .select({
      windowType: rateLimits.windowType,
      msgCount: rateLimits.msgCount,
      tokensUsed: rateLimits.tokensUsed,
    })
    .from(rateLimits)
    .where(
      and(
        eq(rateLimits.userId, userId),
        or(
          and(
            eq(rateLimits.windowType, "hour"),
            eq(rateLimits.windowStart, windowStart("hour", timeZone)),
          ),
          and(
            eq(rateLimits.windowType, "day"),
            eq(rateLimits.windowStart, windowStart("day", timeZone)),
          ),
        ),
      ),
    );
  const hour = current.find((row) => row.windowType === "hour");
  const day = current.find((row) => row.windowType === "day");

  if ((day?.tokensUsed ?? 0) >= limits.tokensPerDay) {
    throw new RateLimitExceededError("day", "tokens");
  }

  if ((hour?.msgCount ?? 0) >= limits.msgsPerHour) {
    throw new RateLimitExceededError("hour", "messages");
  }

  if ((day?.msgCount ?? 0) >= limits.msgsPerDay) {
    throw new RateLimitExceededError("day", "messages");
  }

  const after = await bump(db, userId, timeZone, 1, 0, 0);
  const over =
    after.hour > limits.msgsPerHour ? "hour" : after.day > limits.msgsPerDay ? "day" : null;

  if (over) {
    // Another message took the last unit between the check and the count
    await bump(db, userId, timeZone, -1, 0, 0);
    throw new RateLimitExceededError(over, "messages");
  }
}

/**
 * Gives back a message the server failed to answer
 *
 * @param   db        Own database
 * @param   userId    Person who sent it
 * @param   timeZone  Application time zone
 */
export async function refundMessage(db: Database, userId: number, timeZone: string): Promise<void> {
  await bump(db, userId, timeZone, -1, 0, 0);
}

/**
 * Adds the tokens and cost a turn consumed, whether it answered or not
 *
 * @param   db              Own database
 * @param   userId          Person who sent it
 * @param   tokens          Tokens the turn used
 * @param   costMillionths  Cost of the turn
 * @param   timeZone        Application time zone
 */
export async function recordTokens(
  db: Database,
  userId: number,
  tokens: number,
  costMillionths: number,
  timeZone: string,
): Promise<void> {
  if (tokens === 0 && costMillionths === 0) {
    return;
  }

  await bump(db, userId, timeZone, 0, tokens, costMillionths);
}

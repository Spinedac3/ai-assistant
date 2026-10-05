import { and, eq, sql } from "drizzle-orm";
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
 * Adds to the user's counters of one window and returns them
 *
 * @param   db              Own database
 * @param   userId          Person
 * @param   window          Hour or day
 * @param   timeZone        Application time zone
 * @param   messages        Messages to add
 * @param   tokens          Tokens to add
 * @param   costMillionths  Cost to add
 *
 * @return  The counters after adding
 */
async function bump(
  db: Database,
  userId: number,
  window: "hour" | "day",
  timeZone: string,
  messages: number,
  tokens: number,
  costMillionths: number,
) {
  const [row] = await db
    .insert(rateLimits)
    .values({
      userId,
      windowType: window,
      windowStart: windowStart(window, timeZone),
      msgCount: messages,
      tokensUsed: tokens,
      costMillionths,
    })
    .onConflictDoUpdate({
      target: [rateLimits.userId, rateLimits.windowType, rateLimits.windowStart],
      set: {
        msgCount: sql`${rateLimits.msgCount} + ${messages}`,
        tokensUsed: sql`${rateLimits.tokensUsed} + ${tokens}`,
        costMillionths: sql`${rateLimits.costMillionths} + ${costMillionths}`,
      },
    })
    .returning({ msgCount: rateLimits.msgCount, tokensUsed: rateLimits.tokensUsed });

  return row ?? { msgCount: 0, tokensUsed: 0 };
}

/**
 * Counts a new message and rejects it when it goes over a quota
 *
 * Counting first and checking after is one atomic step per window, so parallel messages cannot
 * all slip through on the same remaining unit.
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
  const [today] = await db
    .select({ tokensUsed: rateLimits.tokensUsed })
    .from(rateLimits)
    .where(
      and(
        eq(rateLimits.userId, userId),
        eq(rateLimits.windowType, "day"),
        eq(rateLimits.windowStart, windowStart("day", timeZone)),
      ),
    );

  if ((today?.tokensUsed ?? 0) >= limits.tokensPerDay) {
    throw new RateLimitExceededError("day", "tokens");
  }

  const hour = await bump(db, userId, "hour", timeZone, 1, 0, 0);
  if (hour.msgCount > limits.msgsPerHour) {
    throw new RateLimitExceededError("hour", "messages");
  }

  const day = await bump(db, userId, "day", timeZone, 1, 0, 0);
  if (day.msgCount > limits.msgsPerDay) {
    throw new RateLimitExceededError("day", "messages");
  }
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
  for (const window of ["hour", "day"] as const) {
    await bump(db, userId, window, timeZone, 0, tokens, costMillionths);
  }
}

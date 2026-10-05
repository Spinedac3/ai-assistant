import { eq, sql } from "drizzle-orm";
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
 * Rejects a new message when the user already used up a window
 *
 * @param   db        Own database
 * @param   userId    Person sending
 * @param   limits    Quotas
 * @param   timeZone  Application time zone
 *
 * @throws  RateLimitExceededError
 */
export async function assertCanSend(
  db: Database,
  userId: number,
  limits: RateLimits,
  timeZone: string,
): Promise<void> {
  const [usage] = await db
    .select({
      hourMsgs: sql<number>`coalesce(sum(${rateLimits.msgCount}) filter (where ${rateLimits.windowType} = 'hour' and ${rateLimits.windowStart} = ${windowStart("hour", timeZone)}), 0)`,
      dayMsgs: sql<number>`coalesce(sum(${rateLimits.msgCount}) filter (where ${rateLimits.windowType} = 'day' and ${rateLimits.windowStart} = ${windowStart("day", timeZone)}), 0)`,
      dayTokens: sql<number>`coalesce(sum(${rateLimits.tokensUsed}) filter (where ${rateLimits.windowType} = 'day' and ${rateLimits.windowStart} = ${windowStart("day", timeZone)}), 0)`,
    })
    .from(rateLimits)
    .where(eq(rateLimits.userId, userId));

  if (Number(usage?.hourMsgs ?? 0) >= limits.msgsPerHour) {
    throw new RateLimitExceededError("hour", "messages");
  }

  if (Number(usage?.dayMsgs ?? 0) >= limits.msgsPerDay) {
    throw new RateLimitExceededError("day", "messages");
  }

  if (Number(usage?.dayTokens ?? 0) >= limits.tokensPerDay) {
    throw new RateLimitExceededError("day", "tokens");
  }
}

/**
 * Counts one answered message against the user's hour and day windows
 *
 * @param   db              Own database
 * @param   userId          Person who sent it
 * @param   tokens          Tokens the turn used
 * @param   costMillionths  Cost of the turn
 * @param   timeZone        Application time zone
 */
export async function recordUsage(
  db: Database,
  userId: number,
  tokens: number,
  costMillionths: number,
  timeZone: string,
): Promise<void> {
  for (const window of ["hour", "day"] as const) {
    await db
      .insert(rateLimits)
      .values({
        userId,
        windowType: window,
        windowStart: windowStart(window, timeZone),
        msgCount: 1,
        tokensUsed: tokens,
        costMillionths,
      })
      .onConflictDoUpdate({
        target: [rateLimits.userId, rateLimits.windowType, rateLimits.windowStart],
        set: {
          msgCount: sql`${rateLimits.msgCount} + 1`,
          tokensUsed: sql`${rateLimits.tokensUsed} + ${tokens}`,
          costMillionths: sql`${rateLimits.costMillionths} + ${costMillionths}`,
        },
      });
  }
}

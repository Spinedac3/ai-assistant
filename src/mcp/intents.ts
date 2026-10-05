import { lt, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { mcpIntents } from "../db/schema.js";

const MAX_QUESTION = 2000;

/**
 * Records what a person asked through an external MCP client; failing to record never fails the call
 *
 * @param   db        Own database
 * @param   userId    Person
 * @param   toolName  Capability the question led to
 * @param   question  Question as the model passed it
 */
export async function recordIntent(
  db: Database,
  userId: number,
  toolName: string,
  question: string,
): Promise<void> {
  try {
    await db
      .insert(mcpIntents)
      .values({ userId, toolName, question: question.slice(0, MAX_QUESTION) });
  } catch {
    // Telemetry only
  }
}

/**
 * Deletes recorded questions older than the retention period
 *
 * @param   db             Own database
 * @param   retentionDays  How long a question is kept
 *
 * @return  How many were deleted
 */
export async function purgeIntents(db: Database, retentionDays: number): Promise<number> {
  const deleted = await db
    .delete(mcpIntents)
    .where(lt(mcpIntents.createdAt, sql`now() - make_interval(days => ${retentionDays})`))
    .returning({ id: mcpIntents.id });

  return deleted.length;
}

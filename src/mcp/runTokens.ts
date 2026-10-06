import { eq, sql } from "drizzle-orm";
import { generateToken, hashToken } from "../auth/opaqueTokens.js";
import type { Database } from "../db/client.js";
import { accessTokens } from "../db/schema.js";
import type { ToolRegistry } from "../tools/registry.js";

export const RUN_CLIENT_ID = "internal-run";

export interface RunInfo {
  // Tools of an agent run, or null for a chat turn, which keeps the meta catalog
  tools: string[] | null;
  conversationId?: number;
  // Tools of a trial, which include a draft no one else can reach; the shared registry otherwise
  registry?: ToolRegistry;
  // Calls of a trial are audited apart, so they never count as real use
  trial?: boolean;
  // Kept in the database too, for a run of another system that must outlive a restart
  persisted?: boolean;
}

// In memory and keyed by the token, never by the person: deducing the run from the user once handed
// a person's chat the catalog of an agent they owned
const runs = new Map<string, RunInfo>();

/**
 * Issues a short-lived token for one CLI process, with no OAuth flow behind it
 *
 * @param   db          Own database
 * @param   userId      Person the process acts for
 * @param   ttlMinutes  Lifetime
 * @param   info        Tools and conversation the token is bound to
 * @param   clientId    Who asked for it: this server, or a machine client
 *
 * @return  The token in clear
 */
export async function mintRunToken(
  db: Database,
  userId: number,
  ttlMinutes: number,
  info: RunInfo,
  clientId = RUN_CLIENT_ID,
): Promise<string> {
  const token = generateToken("ast");

  await db.insert(accessTokens).values({
    userId,
    clientId,
    accessTokenHash: hashToken(token),
    kind: "run",
    runTools: info.persisted && info.tools !== null ? [...info.tools] : null,
    accessExpiresAt: sql`now() + make_interval(mins => ${ttlMinutes})`,
  });
  // A kept run is read from its row, so nothing waits in memory for a revoke that may never come
  if (!info.persisted) {
    runs.set(token, {
      tools: info.tools === null ? null : [...info.tools],
      conversationId: info.conversationId,
      registry: info.registry,
      trial: info.trial,
    });
  }

  return token;
}

/**
 * Finds what a run token is bound to
 *
 * @param   token  Token in clear
 *
 * @return  The run info, or null when the token is not a run token of this process
 */
export function runInfo(token: string): RunInfo | null {
  return runs.get(token) ?? null;
}

/**
 * Ends a run token; its short lifetime is the safety net if this never runs
 *
 * @param   db     Own database
 * @param   token  Token in clear
 */
export async function revokeRunToken(db: Database, token: string): Promise<void> {
  runs.delete(token);
  await db
    .update(accessTokens)
    .set({ revokedAt: sql`now()` })
    .where(eq(accessTokens.accessTokenHash, hashToken(token)));
}

import type { Database } from "./db/client.js";
import { auditLogs } from "./db/schema.js";

export interface AuditEvent {
  userId: number | null;
  level: "info" | "warn" | "error";
  eventCode: string;
  message: string;
  systemCode?: string | null;
  ip?: string | null;
  // What changed, for whoever reviews the log later
  metadata?: Record<string, unknown>;
}

/**
 * Appends a security event; a failure to log never fails the request
 *
 * @param   db     Own database
 * @param   event  What happened
 */
export async function logAudit(db: Database, event: AuditEvent): Promise<void> {
  try {
    await db.insert(auditLogs).values({
      userId: event.userId,
      level: event.level,
      eventCode: event.eventCode,
      message: event.message,
      systemCode: event.systemCode ?? null,
      ipAddress: event.ip ?? null,
      metadata: event.metadata ?? null,
    });
  } catch {
    // Logging is best effort
  }
}

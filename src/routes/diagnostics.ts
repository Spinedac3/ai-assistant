import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Database } from "../db/client.js";

// A probe answers with a short note, or throws with what went wrong
export type Probe = () => Promise<string | undefined>;

export interface DiagnosticsRoutesOptions {
  db: Database;
  // Each service the assistant depends on, by the name a person reads
  probes: Record<string, Probe>;
}

// A service slower than this is as good as down for the person waiting
const PROBE_TIMEOUT_MS = 8_000;

/**
 * Runs a probe within the time a person waits for the page
 *
 * @param   probe  Probe
 *
 * @return  Whether it answered, how long it took and its note or error
 */
async function measure(probe: Probe): Promise<{ ok: boolean; ms: number; detail: string | null }> {
  const started = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const detail = await Promise.race([
      probe(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("no respondió a tiempo")), PROBE_TIMEOUT_MS);
      }),
    ]);
    return { ok: true, ms: Date.now() - started, detail: detail ?? null };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - started,
      detail: String(error instanceof Error ? error.message : error).slice(0, 300),
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Registers the diagnostics: whether each service answers, the latest errors and the tools that
 * fail most, so whoever runs the assistant sees what is wrong before people say it
 *
 * @param   app      Fastify instance
 * @param   options  Database and probes
 */
export default async function diagnosticsRoutes(
  app: FastifyInstance,
  options: DiagnosticsRoutesOptions,
): Promise<void> {
  const { db } = options;

  app.get(
    "/admin/diagnostics",
    { preHandler: [app.requireAuth, app.requireScope("settings.manage")] },
    async () => {
      const names = Object.keys(options.probes);
      const results = await Promise.all(
        names.map((name) => measure(options.probes[name] as Probe)),
      );
      const [errors, failing, queues] = await Promise.all([
        db.execute(sql`
          select event_code, message, created_at from audit_logs
          where level = 'error' order by created_at desc limit 20`),
        db.execute(sql`
          select tool_name, error_code, count(*)::int as failures from tool_calls
          where not success and created_at > now() - interval '24 hours'
          group by tool_name, error_code order by failures desc limit 10`),
        db.execute(sql`
          select
            (select count(*) from notices where status = 'pending')::int as notices_pending,
            (select count(*) from notices where status = 'failed' and created_at > now() - interval '24 hours')::int as notices_failed,
            (select count(*) from document_jobs where status in ('queued', 'running'))::int as documents_waiting,
            (select count(*) from document_jobs where status = 'failed' and created_at > now() - interval '24 hours')::int as documents_failed`),
      ]);
      const counts = queues.rows[0] as Record<string, number>;

      return {
        ok: true,
        data: {
          services: names.map((name, index) => ({ name, ...results[index] })),
          queues: {
            noticesPending: counts.notices_pending,
            noticesFailed: counts.notices_failed,
            documentsWaiting: counts.documents_waiting,
            documentsFailed: counts.documents_failed,
          },
          errors: (errors.rows as Record<string, unknown>[]).map((row) => ({
            event: String(row.event_code),
            message: String(row.message),
            at: new Date(row.created_at as string).toISOString(),
          })),
          failingTools: (failing.rows as Record<string, unknown>[]).map((row) => ({
            tool: String(row.tool_name),
            error: (row.error_code as string | null) ?? null,
            failures: Number(row.failures),
          })),
        },
      };
    },
  );
}

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import type { Database } from "../db/client.js";
import { usageReport } from "../usage/report.js";

export interface UsageRoutesOptions {
  db: Database;
  // Zone where the days of the report are cut
  timeZone: string;
}

const reportQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });

/**
 * Registers the usage report
 *
 * @param   app      Fastify instance
 * @param   options  Database and time zone
 */
export default async function usageRoutes(
  app: FastifyInstance,
  options: UsageRoutesOptions,
): Promise<void> {
  const { db } = options;

  app.get(
    "/admin/usage",
    { preHandler: [app.requireAuth, app.requireScope("usage.read")] },
    async (request, reply) => {
      const query = reportQuery.safeParse(request.query);
      if (!query.success) {
        return reply.code(400).send({ ok: false, error: "invalid_query" });
      }

      const report = await usageReport(db, query.data.days, options.timeZone);
      // It names every person who may chat, so who looked at it stays on record
      await logAudit(db, {
        userId: request.authUser?.id ?? null,
        level: "info",
        eventCode: "usage.viewed",
        message: `Reporte de uso de ${query.data.days} días`,
        ip: request.ip,
        metadata: { days: query.data.days },
      });

      return { ok: true, data: report };
    },
  );
}

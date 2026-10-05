import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";
import { usageReport } from "../usage/report.js";

export interface UsageRoutesOptions {
  db: Database;
  // Zone where the days of the report are cut
  timeZone: string;
}

const reportQuery = z.object({ days: z.coerce.number().int().min(1).max(365).default(30) });
const userParams = z.object({ id: z.coerce.number().int().positive() });
const serviceBody = z.object({ is_service: z.boolean() }).strict();

/**
 * Registers the usage report and the marking of service accounts
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

      return { ok: true, data: await usageReport(db, query.data.days, options.timeZone) };
    },
  );

  // A system that logs in as an account is counted apart, so it neither inflates nor hides people
  app.put(
    "/admin/users/:id/service",
    { preHandler: [app.requireAuth, app.requireScope("users.manage")] },
    async (request, reply) => {
      const params = userParams.safeParse(request.params);
      const body = serviceBody.safeParse(request.body);
      if (!params.success || !body.success) {
        return reply.code(400).send({ ok: false, error: "invalid_body" });
      }
      const updated = await db
        .update(users)
        .set({ isService: body.data.is_service })
        .where(and(eq(users.id, params.data.id), isNull(users.deletedAt)))
        .returning({ id: users.id });
      if (updated.length === 0) {
        return reply.code(404).send({ ok: false, error: "user_not_found" });
      }

      await logAudit(db, {
        userId: request.authUser?.id ?? null,
        level: "info",
        eventCode: "users.service_changed",
        message: `Cuenta ${params.data.id} ${body.data.is_service ? "marcada" : "desmarcada"} como de servicio`,
        ip: request.ip,
      });

      return { ok: true, data: { id: params.data.id, is_service: body.data.is_service } };
    },
  );
}

import { and, eq, isNull } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";
import { isSettingKey, listSettings, writeSetting } from "../settings.js";

export interface AdminRoutesOptions {
  db: Database;
}

const keyParams = z.object({ key: z.string().min(1).max(100) });
const valueBody = z.object({ value: z.unknown() });
const userParams = z.object({ id: z.coerce.number().int().positive() });
const serviceBody = z.object({ is_service: z.boolean() }).strict();

/**
 * Registers the administration routes for runtime settings and service accounts
 *
 * @param   app      Fastify instance
 * @param   options  Database
 */
export default async function adminRoutes(
  app: FastifyInstance,
  options: AdminRoutesOptions,
): Promise<void> {
  const { db } = options;
  const guard = { preHandler: [app.requireAuth, app.requireScope("settings.manage")] };

  app.get("/admin/settings", guard, async () => ({ ok: true, data: await listSettings(db) }));

  app.put("/admin/settings/:key", guard, async (request, reply) => {
    const { key } = keyParams.parse(request.params);
    if (!isSettingKey(key)) {
      return reply.code(404).send({ ok: false, error: "unknown_setting" });
    }

    const body = valueBody.safeParse(request.body);
    const userId = request.authUser?.id ?? 0;
    const result = await writeSetting(db, key, body.data?.value, userId);

    if (!result.ok) {
      return reply.code(400).send({ ok: false, error: "invalid_value", message: result.message });
    }

    await logAudit(db, {
      userId,
      level: "info",
      eventCode: "settings.changed",
      message: `${key} = ${JSON.stringify(result.value)}`,
      ip: request.ip,
    });

    return { ok: true, data: { key, value: result.value } };
  });

  // A system that logs in as an account is counted apart, so it neither inflates nor hides people
  app.put(
    "/admin/users/:id/service",
    { preHandler: [app.requireAuth, app.requireScope("users.manage")] },
    async (request, reply) => {
      const params = userParams.safeParse(request.params);
      if (!params.success) {
        return reply.code(400).send({ ok: false, error: "invalid_id" });
      }
      const body = serviceBody.safeParse(request.body);
      if (!body.success) {
        return reply.code(400).send({ ok: false, error: "invalid_body" });
      }
      const id = params.data.id;
      const live = and(eq(users.id, id), isNull(users.deletedAt));
      const [before] = await db.select({ isService: users.isService }).from(users).where(live);
      if (!before) {
        return reply.code(404).send({ ok: false, error: "user_not_found" });
      }

      if (before.isService !== body.data.is_service) {
        await db.update(users).set({ isService: body.data.is_service }).where(live);
        await logAudit(db, {
          userId: request.authUser?.id ?? null,
          level: "info",
          eventCode: "users.service_changed",
          message: `Cuenta ${id} ${body.data.is_service ? "marcada" : "desmarcada"} como de servicio`,
          ip: request.ip,
          metadata: { target: id, before: before.isService, after: body.data.is_service },
        });
      }

      return { ok: true, data: { id, is_service: body.data.is_service } };
    },
  );
}

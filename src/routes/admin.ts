import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import type { Database } from "../db/client.js";
import { isSettingKey, listSettings, writeSetting } from "../settings.js";

export interface AdminRoutesOptions {
  db: Database;
}

const keyParams = z.object({ key: z.string().min(1).max(100) });
const valueBody = z.object({ value: z.unknown() });

/**
 * Registers the administration routes for runtime settings
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
}

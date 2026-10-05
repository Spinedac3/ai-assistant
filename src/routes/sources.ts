import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import type { Database } from "../db/client.js";
import {
  connectionFor,
  connectionOf,
  deleteSource,
  listSources,
  SOURCE_CODE,
  saveSource,
  sourceInput,
  verifySource,
} from "../sources/registry.js";
import type { Secrets } from "../vault/envelope.js";

export interface SourcesRoutesOptions {
  db: Database;
  secrets: Secrets;
}

const codeParams = z.object({ code: z.string().regex(SOURCE_CODE) });

/**
 * Registers the administration of the databases the tools read
 *
 * @param   app      Fastify instance
 * @param   options  Database and vault
 */
export default async function sourcesRoutes(
  app: FastifyInstance,
  options: SourcesRoutesOptions,
): Promise<void> {
  const { db, secrets } = options;
  const guard = { preHandler: [app.requireAuth, app.requireScope("sources.manage")] };

  app.get("/admin/sources", guard, async () => ({ ok: true, data: await listSources(db) }));

  // Registering an existing code replaces it, verified again with its password like a new one
  app.post("/admin/sources", guard, async (request, reply) => {
    const parsed = sourceInput.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_source",
        message: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
    }

    const verification = await verifySource(connectionOf(parsed.data));
    if (!verification.ok) {
      if (verification.error === "connection_failed") {
        request.log.warn(
          { source: parsed.data.code, detail: verification.detail },
          "source connection failed",
        );
        return reply
          .code(400)
          .send({ ok: false, error: verification.error, message: verification.message });
      }

      return reply.code(400).send({
        ...verification,
        message: "El usuario de la base puede escribir; pide al DBA un usuario de solo lectura",
      });
    }

    const userId = request.authUser?.id ?? 0;
    await saveSource(db, secrets, parsed.data, userId);
    await logAudit(db, {
      userId,
      level: "info",
      eventCode: "sources.saved",
      message: `${parsed.data.code} (${parsed.data.engine} ${parsed.data.host}/${parsed.data.database})`,
      ip: request.ip,
    });

    return reply.code(201).send({ ok: true, data: { code: parsed.data.code } });
  });

  app.post("/admin/sources/:code/test", guard, async (request, reply) => {
    const { code } = codeParams.parse(request.params);
    const source = await connectionFor(db, secrets, code);
    if (!source) {
      return reply.code(404).send({ ok: false, error: "source_not_found" });
    }

    const verification = await verifySource(source.info);
    if (!verification.ok && verification.error === "connection_failed") {
      request.log.warn({ source: code, detail: verification.detail }, "source connection failed");
      return {
        ok: true,
        data: { ok: false, error: verification.error, message: verification.message },
      };
    }

    return { ok: true, data: verification };
  });

  app.delete("/admin/sources/:code", guard, async (request, reply) => {
    const { code } = codeParams.parse(request.params);
    const deleted = await deleteSource(db, code);
    if (deleted === "missing") {
      return reply.code(404).send({ ok: false, error: "source_not_found" });
    }
    if (deleted === "in_use") {
      return reply.code(409).send({
        ok: false,
        error: "source_in_use",
        message: "La fuente tiene herramientas creadas; bórralas antes de borrar la fuente",
      });
    }

    await logAudit(db, {
      userId: request.authUser?.id ?? null,
      level: "info",
      eventCode: "sources.deleted",
      message: code,
      ip: request.ip,
    });

    return { ok: true, data: { code } };
  });
}

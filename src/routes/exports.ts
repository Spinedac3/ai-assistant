import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { ExportPart, ExportStore } from "../exports/store.js";
import { XLSX_CONTENT_TYPE } from "../exports/xlsx.js";

export interface ExportsRoutesOptions {
  exports: ExportStore;
}

const params = z.object({ id: z.string().uuid() });
const query = z.object({ exp: z.coerce.number().int(), sig: z.string().min(1).max(100) });

const NOT_FOUND = {
  ok: false,
  error: "export_not_found",
  message: "El archivo no existe o su link venció; vuelve a pedir los datos",
};

/**
 * Registers the download of exported Excel files: a signed link is the permission outside the
 * panel, and inside it the session of the person who ran the tool
 *
 * @param   app      Fastify instance
 * @param   options  Store of exports
 */
export default async function exportsRoutes(
  app: FastifyInstance,
  options: ExportsRoutesOptions,
): Promise<void> {
  /**
   * Finds the part of an export the request may have: by its signed link, or by the session of
   * the person who ran the tool
   *
   * @param   request  Request
   * @param   reply    Reply
   * @param   part     The file or its preview
   *
   * @return  The part, or null once a reply is sent or when there is nothing to give
   */
  const find = async (request: FastifyRequest, reply: FastifyReply, part: ExportPart) => {
    const id = params.safeParse(request.params);
    if (!id.success) {
      return null;
    }
    const signed = request.query as { sig?: unknown };
    if (signed?.sig !== undefined) {
      const link = query.safeParse(request.query);
      // A forged, expired or deleted link looks the same: the file is simply not there
      return link.success
        ? options.exports.open(id.data.id, link.data.exp, link.data.sig, part)
        : null;
    }
    // The same check every other route runs before it, here only for a link without signature
    await app.requireAuth.call(app, request, reply, () => undefined);
    const userId = request.authUser?.id;
    // Someone else's file looks the same as one that is not there
    return reply.sent || userId === undefined
      ? null
      : options.exports.openOwned(id.data.id, userId, part);
  };

  app.get("/exports/:id/preview", async (request, reply) => {
    const preview = await find(request, reply, "preview");
    if (reply.sent) {
      return reply;
    }
    if (!preview) {
      return reply.code(404).send(NOT_FOUND);
    }

    return reply
      .header("Content-Type", "application/json; charset=utf-8")
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .send(preview.stream);
  });

  app.get("/exports/:id", async (request, reply) => {
    const file = await find(request, reply, "file");
    if (reply.sent) {
      return reply;
    }
    if (!file) {
      return reply.code(404).send(NOT_FOUND);
    }

    return reply
      .header("Content-Type", XLSX_CONTENT_TYPE)
      .header("Content-Disposition", `attachment; filename="${file.fileName}"`)
      .header("X-Content-Type-Options", "nosniff")
      .header("Cache-Control", "private, no-store")
      .header("Referrer-Policy", "no-referrer")
      .send(file.stream);
  });
}

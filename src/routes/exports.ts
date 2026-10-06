import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExportStore } from "../exports/store.js";
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
  app.get("/exports/:id", async (request, reply) => {
    const id = params.safeParse(request.params);
    if (!id.success) {
      return reply.code(404).send(NOT_FOUND);
    }
    const signed = request.query as { sig?: unknown };
    let file: Awaited<ReturnType<ExportStore["open"]>>;
    if (signed?.sig !== undefined) {
      const link = query.safeParse(request.query);
      // A forged, expired or deleted link looks the same: the file is simply not there
      file = link.success
        ? await options.exports.open(id.data.id, link.data.exp, link.data.sig)
        : null;
    } else {
      // The same check every other route runs before it, here only for a link without signature
      await app.requireAuth.call(app, request, reply, () => undefined);
      if (reply.sent) {
        return reply;
      }
      const userId = request.authUser?.id;
      // Someone else's file looks the same as one that is not there
      file = userId === undefined ? null : await options.exports.openOwned(id.data.id, userId);
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

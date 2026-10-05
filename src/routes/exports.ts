import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { ExportStore } from "../exports/store.js";
import { XLSX_CONTENT_TYPE } from "../exports/xlsx.js";

export interface ExportsRoutesOptions {
  exports: ExportStore;
}

const params = z.object({ id: z.string().uuid() });
const query = z.object({ exp: z.coerce.number().int(), sig: z.string().min(1).max(100) });

/**
 * Registers the download of exported Excel files; the signed link is the permission
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
    const link = query.safeParse(request.query);
    // A forged, expired or deleted link looks the same: the file is simply not there
    const file =
      id.success && link.success
        ? await options.exports.open(id.data.id, link.data.exp, link.data.sig)
        : null;

    if (!file) {
      return reply.code(404).send({
        ok: false,
        error: "export_not_found",
        message: "El archivo no existe o su link venció; vuelve a pedir los datos",
      });
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

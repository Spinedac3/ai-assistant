import multipart, { type MultipartFile } from "@fastify/multipart";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import type { Database } from "../db/client.js";
import { MAX_PAGES, openPdf, type PdfConverter } from "../rag/convert.js";
import { DOC_CODE, writeDocument } from "../rag/document.js";
import { type Index, isCurrent, removeDocument } from "../rag/ingest.js";
import { enqueue, findJob } from "../rag/jobs.js";
import { scopeFilter } from "../rag/search.js";
import { CONTENT_TYPES, type DocumentStorage } from "../rag/storage.js";
import { MAX_MARKDOWN_BYTES, storeDocument } from "../rag/upload.js";

export interface DocsRoutesOptions {
  db: Database;
  index: Index;
  storage: DocumentStorage;
  // Turns an uploaded PDF into a document to review; without it only Markdown is taken
  converter?: PdfConverter;
}

// The scope that lets a person read an area, which names the area
const AREA_SCOPE = /^docs\.([a-z0-9_-]+)\.read$/;
const CONVERSION_NOT_FOUND = {
  ok: false,
  error: "conversion_not_found",
  message: "Esa conversión no existe o ya se publicó",
};
const conversionParams = z.object({ id: z.string().uuid() });
// The header of a converted PDF as the person left it; the document checks it again on publishing
const publishBody = z
  .object({
    header: z
      .object({
        doc_code: z.string().trim().min(1).max(100),
        doc_title: z.string().trim().min(1).max(300),
        doc_version: z.string().trim().min(1).max(30),
        area: z.string().trim().min(1).max(40),
        doc_type: z.string().trim().max(60).optional(),
        effective_date: z.string().trim().max(10).optional(),
        tags: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
      })
      .strict(),
    markdown: z.string().min(1),
  })
  .strict();

// The PDF original can be much larger than its markdown
const MAX_ORIGINAL_BYTES = 50 * 1024 * 1024;
// Every document has a first chunk, so listing those lists each document once
const LIST_LIMIT = 5_000;

const codeParams = z.object({ code: z.string().regex(DOC_CODE) });
const jobParams = z.object({ id: z.coerce.number().int().positive() });
const originalQuery = z.object({ kind: z.enum(["md", "pdf"]).default("md") });

/**
 * Reads an uploaded file into memory, keeping nothing once it passes a size
 *
 * @param   part      Uploaded file
 * @param   maxBytes  Size limit
 *
 * @return  The contents, or null when it is too large
 */
async function readCapped(part: MultipartFile, maxBytes: number): Promise<Buffer | null> {
  const pieces: Buffer[] = [];
  let size = 0;

  // Read to the end even past the limit: leaving the stream would stall the rest of the request
  // and the connection with it
  for await (const piece of part.file) {
    size += (piece as Buffer).length;
    if (size <= maxBytes) {
      pieces.push(piece as Buffer);
    }
  }

  return size > maxBytes || part.file.truncated ? null : Buffer.concat(pieces);
}

/**
 * Registers the routes to upload, list, download, reindex and delete documents
 *
 * @param   app      Fastify instance
 * @param   options  Database, index and storage of originals
 */
export default async function docsRoutes(
  app: FastifyInstance,
  options: DocsRoutesOptions,
): Promise<void> {
  const { db, index, storage } = options;
  const manage = { preHandler: [app.requireAuth, app.requireScope("docs.manage")] };
  const read = { preHandler: [app.requireAuth, app.requireScope("chat.use")] };

  await app.register(multipart, { limits: { files: 2, fileSize: MAX_ORIGINAL_BYTES, fields: 0 } });

  app.post("/docs", manage, async (request, reply) => {
    const limits = { document: MAX_MARKDOWN_BYTES, original: MAX_ORIGINAL_BYTES };
    const files: Partial<Record<keyof typeof limits, Buffer>> = {};

    for await (const part of request.files()) {
      const field = part.fieldname as keyof typeof limits;
      // Checked before reading, so an unexpected or repeated file is never held in memory
      if (!(field in limits) || files[field]) {
        part.file.resume();
        return reply.code(400).send({
          ok: false,
          error: "unexpected_file",
          message: "Solo se aceptan un archivo document (.md) y un original (.pdf)",
        });
      }

      const data = await readCapped(part, limits[field]);
      if (!data) {
        return reply.code(413).send({
          ok: false,
          error: "file_too_large",
          message:
            field === "document"
              ? "El .md supera los 2 MB; divídelo en documentos más chicos"
              : "El PDF supera los 50 MB",
        });
      }

      files[field] = data;
    }

    const { document: markdown, original } = files;
    if (!markdown) {
      return reply.code(400).send({
        ok: false,
        error: "missing_document",
        message: "Falta el archivo .md en el campo document",
      });
    }

    // A PDF starts with %PDF; anything else under that name is refused, not stored
    if (original && original.subarray(0, 4).toString("latin1") !== "%PDF") {
      return reply.code(400).send({
        ok: false,
        error: "invalid_original",
        message: "El original debe ser un PDF",
      });
    }

    const stored = await storeDocument(
      { db, index, storage },
      markdown.toString("utf8"),
      {
        userId: request.authUser?.id ?? 0,
        scopes: request.authUser?.scopes ?? new Set<string>(),
        ip: request.ip,
      },
      original,
    );
    if (!stored.ok) {
      return reply
        .code(
          stored.error === "older_version" ? 409 : stored.error === "area_not_readable" ? 403 : 400,
        )
        .send({ ok: false, error: stored.error, message: stored.message });
    }

    return reply
      .code(202)
      .send({ ok: true, data: { job_id: stored.jobId, doc_code: stored.frontmatter.doc_code } });
  });

  /**
   * Finds a conversion of the person asking, or replies that there is none
   *
   * @param   request  Request
   * @param   reply    Reply
   *
   * @return  The conversion, or null once the reply is sent
   */
  const ownConversion = async (request: FastifyRequest, reply: FastifyReply) => {
    const converter = options.converter;
    const id = conversionParams.safeParse(request.params);
    const found =
      converter && id.success ? await converter.find(id.data.id, request.authUser?.id ?? 0) : null;
    if (!found) {
      reply.code(404).send(CONVERSION_NOT_FOUND);
      return null;
    }

    return found;
  };

  // A PDF alone: its pages become Markdown in the background, to review before publishing
  app.post("/docs/conversions", manage, async (request, reply) => {
    const converter = options.converter;
    if (!converter) {
      return reply.code(503).send({
        ok: false,
        error: "conversion_off",
        message: "La conversión de PDF no está disponible",
      });
    }
    let pdf: Buffer | null = null;
    let fileName = "documento.pdf";
    for await (const part of request.files()) {
      if (part.fieldname !== "original" || pdf) {
        part.file.resume();
        return reply.code(400).send({
          ok: false,
          error: "unexpected_file",
          message: "Solo se acepta un PDF en el campo original",
        });
      }
      pdf = await readCapped(part, MAX_ORIGINAL_BYTES);
      if (!pdf) {
        return reply
          .code(413)
          .send({ ok: false, error: "file_too_large", message: "El PDF supera los 50 MB" });
      }
      fileName = part.filename || fileName;
    }
    // A PDF starts with %PDF; anything else under that name is refused, not stored
    const isPdf = pdf?.subarray(0, 4).toString("latin1") === "%PDF";
    if (!pdf || !isPdf) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_original",
        message: "Sube un archivo PDF",
      });
    }

    // The header may only name an area the person can read, as publishing will check
    const areas = [...(request.authUser?.scopes ?? [])]
      .map((scope) => AREA_SCOPE.exec(scope)?.[1])
      .filter((area): area is string => Boolean(area));
    // Refused now, not after minutes of waiting: a file that does not open, or too long to review
    const opened = await openPdf(pdf);
    if (!opened) {
      return reply.code(400).send({
        ok: false,
        error: "unreadable_pdf",
        message: "No se pudo abrir el PDF; si tiene contraseña, quítasela y vuelve a subirlo",
      });
    }
    if (opened.getPageCount() > MAX_PAGES) {
      return reply.code(400).send({
        ok: false,
        error: "too_many_pages",
        message: `El PDF tiene más de ${MAX_PAGES} páginas; divídelo en documentos más chicos`,
      });
    }
    const id = await converter.start(
      request.authUser?.id ?? 0,
      fileName,
      pdf,
      opened.getPageCount(),
      areas,
    );

    return reply.code(202).send({ ok: true, data: { id } });
  });

  app.get("/docs/conversions", manage, async (request) => {
    const rows = (await options.converter?.list(request.authUser?.id ?? 0)) ?? [];

    return {
      ok: true,
      data: rows.map((row) => ({
        id: row.id,
        file_name: row.fileName,
        status: row.status,
        pages_done: row.pagesDone,
        pages_total: row.pagesTotal,
        error: row.error,
        created_at: row.createdAt,
      })),
    };
  });

  app.get("/docs/conversions/:id", manage, async (request, reply) => {
    const found = await ownConversion(request, reply);
    if (!found) {
      return reply;
    }

    return {
      ok: true,
      data: {
        id: found.id,
        file_name: found.fileName,
        status: found.status,
        pages_done: found.pagesDone,
        pages_total: found.pagesTotal,
        error: found.error,
        markdown: found.markdown,
        suggested: found.suggested,
      },
    };
  });

  // The person's header and Markdown, with the PDF as the original: published as any upload
  app.post("/docs/conversions/:id/publish", manage, async (request, reply) => {
    const found = await ownConversion(request, reply);
    if (!found) {
      return reply;
    }
    if (found.status !== "done") {
      return reply.code(409).send({
        ok: false,
        error: "conversion_not_done",
        message: "La conversión todavía no terminó",
      });
    }
    const body = publishBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ ok: false, error: "invalid_body", message: body.error.issues[0]?.message });
    }
    const markdown = writeDocument(
      { ...body.data.header, tags: body.data.header.tags ?? [] },
      body.data.markdown,
    );
    if (Buffer.byteLength(markdown) > MAX_MARKDOWN_BYTES) {
      return reply.code(413).send({
        ok: false,
        error: "file_too_large",
        message: "El documento supera los 2 MB; divide el PDF en partes",
      });
    }
    const converter = options.converter as PdfConverter;
    const stored = await storeDocument(
      { db, index, storage },
      markdown,
      {
        userId: request.authUser?.id ?? 0,
        scopes: request.authUser?.scopes ?? new Set<string>(),
        ip: request.ip,
      },
      await converter.read(found.id),
    );
    if (!stored.ok) {
      return reply
        .code(
          stored.error === "older_version" ? 409 : stored.error === "area_not_readable" ? 403 : 400,
        )
        .send({ ok: false, error: stored.error, message: stored.message });
    }
    await converter.remove(found.id);

    return reply
      .code(202)
      .send({ ok: true, data: { job_id: stored.jobId, doc_code: stored.frontmatter.doc_code } });
  });

  app.delete("/docs/conversions/:id", manage, async (request, reply) => {
    const found = await ownConversion(request, reply);
    if (!found) {
      return reply;
    }
    await options.converter?.remove(found.id);

    return { ok: true, data: { id: found.id } };
  });

  app.get("/docs/jobs/:id", manage, async (request, reply) => {
    const { id } = jobParams.parse(request.params);
    const job = await findJob(db, id);
    if (!job) {
      return reply.code(404).send({ ok: false, error: "job_not_found" });
    }

    return { ok: true, data: job };
  });

  app.get("/docs", read, async (request) => {
    const filter = scopeFilter(request.authUser?.scopes ?? new Set());
    if (!filter) {
      return { ok: true, data: [] };
    }

    const documents = await index.solr.query(index.cores.current, {
      query: "chunk_index:0",
      filter: [filter],
      fields: ["doc_code", "doc_title", "doc_version", "doc_type", "required_scope", "updated_at"],
      sort: "doc_code asc",
      limit: LIST_LIMIT,
    });

    return { ok: true, data: documents };
  });

  app.get("/docs/:code/original", read, async (request, reply) => {
    const { code } = codeParams.parse(request.params);
    const { kind } = originalQuery.parse(request.query);
    const userScopes = request.authUser?.scopes ?? new Set<string>();

    // Current, and saved under an area the person reads; anything else looks like a missing file
    const original = (await isCurrent(index, code)) ? await storage.open(code, kind) : null;
    if (!original || !userScopes.has(original.requiredScope)) {
      original?.stream.destroy();
      return reply.code(404).send({ ok: false, error: "document_not_found" });
    }

    return reply
      .header("Content-Type", CONTENT_TYPES[kind])
      .header("Content-Disposition", `attachment; filename="${code}.${kind}"`)
      .header("X-Content-Type-Options", "nosniff")
      .send(original.stream);
  });

  app.post("/docs/:code/reindex", manage, async (request, reply) => {
    const { code } = codeParams.parse(request.params);
    // Only the current version: reindexing a superseded one would roll its document back
    if (!(await isCurrent(index, code)) || !(await storage.exists(code, "md"))) {
      return reply.code(404).send({
        ok: false,
        error: "document_not_found",
        message: "Solo se reindexa la versión vigente de un documento",
      });
    }

    const userId = request.authUser?.id ?? 0;
    const job = await enqueue(db, code, "reindex", userId);

    return reply.code(202).send({ ok: true, data: { job_id: job, doc_code: code } });
  });

  app.delete("/docs/:code", manage, async (request, reply) => {
    const { code } = codeParams.parse(request.params);
    if (!(await isCurrent(index, code))) {
      return reply.code(404).send({ ok: false, error: "document_not_found" });
    }

    // Originals first: a job indexing this code then sees them gone and removes it again, so the
    // delete wins whichever finishes last
    await storage.remove(code);
    await removeDocument(index, code);

    await logAudit(db, {
      userId: request.authUser?.id ?? null,
      level: "info",
      eventCode: "docs.deleted",
      message: code,
      ip: request.ip,
    });

    return { ok: true, data: { doc_code: code } };
  });
}

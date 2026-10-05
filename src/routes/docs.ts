import multipart, { type MultipartFile } from "@fastify/multipart";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import type { Database } from "../db/client.js";
import { DOC_CODE } from "../rag/document.js";
import { type Index, isCurrent, removeDocument } from "../rag/ingest.js";
import { enqueue, findJob } from "../rag/jobs.js";
import { scopeFilter } from "../rag/search.js";
import { CONTENT_TYPES, type DocumentStorage } from "../rag/storage.js";
import { storeDocument } from "../rag/upload.js";

export interface DocsRoutesOptions {
  db: Database;
  index: Index;
  storage: DocumentStorage;
}

// A long manual in markdown stays well under this; the PDF original can be much larger
const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
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
      { userId: request.authUser?.id ?? 0, ip: request.ip },
      original,
    );
    if (!stored.ok) {
      return reply
        .code(stored.error === "older_version" ? 409 : 400)
        .send({ ok: false, error: stored.error, message: stored.message });
    }

    return reply
      .code(202)
      .send({ ok: true, data: { job_id: stored.jobId, doc_code: stored.frontmatter.doc_code } });
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

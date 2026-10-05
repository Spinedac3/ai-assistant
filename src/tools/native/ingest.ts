import { logAudit } from "../../audit.js";
import { oneAtATime } from "../../lib/oneAtATime.js";
import { areaScope, DOC_CODE, parseDocument } from "../../rag/document.js";
import { currentOfFamily, isCurrent } from "../../rag/ingest.js";
import { enqueue, findJob } from "../../rag/jobs.js";
import type { PartUpload } from "../../rag/storage.js";
import {
  areaExists,
  listAreas,
  MAX_MARKDOWN_BYTES,
  storeDocument,
  type UploadDependencies,
  writeDocument,
} from "../../rag/upload.js";
import type { Tool, ToolContext, ToolResult } from "../contract.js";

export const INGEST = "ingest_document";

const MODES = ["validate", "ingest", "reclassify", "status"] as const;
type Mode = (typeof MODES)[number];

// A procedure fits in one call; a long manual goes in parts, so no argument grows unbounded
const MAX_MARKDOWN_CHARS = 400_000;
const MAX_PARTS = 30;
// An upload sends its parts within minutes; a part older than this is of one left unfinished
const PART_LIFETIME_MS = 3_600_000;

const REQUIRED = [
  {
    field: "doc_code",
    ask: "Código del documento con su versión al final, ej. 'GUIA-BODEGA-V002'.",
  },
  { field: "doc_title", ask: "Título oficial del documento." },
  { field: "doc_version", ask: "Versión, ej. 'V002' (la misma del final del código)." },
  { field: "area", ask: "Área de acceso: define quién puede LEER el documento." },
] as const;

const CONVERSION = [
  "Convierte el documento a markdown de forma MECÁNICA: transcribe el texto tal cual, sin resumir, parafrasear ni mejorar la redacción.",
  "Conserva la estructura: títulos como encabezados (#, ##, ###), listas como listas, tablas como tablas markdown.",
  "No incluyas encabezado YAML en markdown: lo arma el servidor; markdown es SOLO el cuerpo.",
  "Omite encabezados y pies de página repetidos y números de página.",
  `Si el markdown pasa de ${MAX_MARKDOWN_CHARS / 1000} mil caracteres, envíalo en partes con part y parts, cortando SIEMPRE al inicio de una sección. Reenviar una parte la reemplaza.`,
];

const JOB_STATUS: Record<string, string> = {
  queued: "En cola: se indexa en segundos.",
  running: "Indexándose ahora.",
  done: "Indexado y disponible en la búsqueda de documentos.",
  failed: "Falló el indexado: revisa error, corrige y vuelve a cargar el mismo código.",
};

type Args = {
  mode: Mode;
  doc_code?: string;
  doc_title?: string;
  doc_version?: string;
  doc_revision?: string;
  area?: string;
  doc_type?: string;
  status?: string;
  effective_date?: string;
  tags?: string[];
  markdown?: string;
  part?: number;
  parts?: number;
  job_id?: number;
};

/**
 * Builds a refusal the model reads
 *
 * @param   error    Machine-readable reason
 * @param   message  Reason in Spanish
 *
 * @return  The failed result
 */
function refuse(error: string, message: string): ToolResult {
  return { ok: false, error, message };
}

/**
 * Checks the fields of a document before it is converted: what is missing, what is wrong and
 * whether a version of it is already current
 *
 * @param   deps     Database, index and storage
 * @param   args     Fields the model could infer
 * @param   context  Who calls
 *
 * @return  What to ask the person and how to convert the document
 */
async function validate(
  deps: UploadDependencies,
  args: Args,
  context: ToolContext,
): Promise<ToolResult> {
  const areas = await listAreas(deps.db);
  const missing = REQUIRED.filter(({ field }) => !args[field]);
  // The code's shape is already checked by the input schema; the areas live in the database
  const invalid =
    args.area && !areas.includes(args.area)
      ? [{ field: "area", problem: `Área desconocida; usa una de: ${areas.join(", ")}.` }]
      : [];

  let current: Record<string, unknown> | null = null;
  if (args.doc_code) {
    try {
      // A version in an area the person does not read is not described to them
      const [newest] = (await currentOfFamily(deps.index, args.doc_code)).filter((document) =>
        context.scopes.has(document.required_scope),
      );
      current = newest
        ? {
            doc_code: newest.doc_code,
            doc_title: newest.doc_title,
            doc_version: newest.doc_version,
            updated_at: newest.updated_at,
            same_code: newest.doc_code === args.doc_code,
          }
        : null;
    } catch {
      current = { warning: "No se pudo revisar si ya hay una versión cargada; puedes continuar." };
    }
  }

  return {
    ok: true,
    data: {
      missing,
      invalid,
      areas,
      current_version: current,
      conversion: CONVERSION,
      note:
        "Pide a la persona SOLO lo que falta y corrige lo inválido; no inventes valores. " +
        (current && "doc_code" in current
          ? "Ya hay una versión cargada (current_version): confirma que sube una versión nueva con el código terminado en la versión correcta. "
          : "") +
        "Después llama con mode 'ingest' y el markdown, y confirma con mode 'status'.",
    },
  };
}

/**
 * Keeps a part of a document sent in pieces and, once all are in, puts the body together
 *
 * @param   deps    Database, index and storage
 * @param   upload  Who sends which document, in how many parts
 * @param   part    This part's number
 * @param   text    This part's markdown
 *
 * @return  The whole body, the parts still missing, or that the parts already pass the size
 */
async function gather(
  deps: UploadDependencies,
  upload: PartUpload,
  part: number,
  text: string,
): Promise<{ body: string } | { pending: number[] } | { tooLarge: true }> {
  await deps.storage.savePart(upload, part, text);
  const received = await deps.storage.partsReceived(upload, PART_LIFETIME_MS);
  // Cut as soon as the parts pass the size of a document, not after holding all of them
  if (received.reduce((total, item) => total + item.bytes, 0) > MAX_MARKDOWN_BYTES) {
    return { tooLarge: true };
  }

  const numbers = new Set(received.map((item) => item.part));
  const pending = Array.from({ length: upload.parts }, (_, index) => index + 1).filter(
    (number) => !numbers.has(number),
  );
  if (pending.length > 0) {
    return { pending };
  }

  const texts = await Promise.all(
    Array.from({ length: upload.parts }, (_, index) => deps.storage.readPart(upload, index + 1)),
  );

  return { body: texts.join("\n\n") };
}

/**
 * Stores a converted document, gathering it first when it comes in parts, and queues its indexing
 *
 * @param   deps     Database, index and storage
 * @param   args     Fields and markdown body
 * @param   context  Who calls
 *
 * @return  The queued job, the part received, or why it was refused
 */
async function ingest(
  deps: UploadDependencies,
  args: Args,
  context: ToolContext,
): Promise<ToolResult> {
  const lacking = [...REQUIRED.map(({ field }) => field), "markdown" as const].filter(
    (field) => !args[field],
  );
  if (lacking.length > 0) {
    return refuse(
      "missing_fields",
      `Faltan ${lacking.join(", ")}. Usa mode 'validate' para saber qué pedir.`,
    );
  }

  const code = String(args.doc_code);
  const area = String(args.area);
  const part = args.part ?? 1;
  const parts = args.parts ?? 1;
  if (part > parts) {
    return refuse("invalid_part", `part (${part}) no puede pasar de parts (${parts}).`);
  }
  if (!(await areaExists(deps.db, area))) {
    return refuse(
      "unknown_area",
      `El área ${area} no existe. Usa mode 'validate' para ver las áreas.`,
    );
  }
  // Also checked on storing; here first, so no part is kept for an area they cannot publish to
  if (!context.scopes.has(areaScope(area))) {
    return refuse(
      "area_not_readable",
      `No lees el área ${area}, así que no puedes publicar en ella.`,
    );
  }

  // Parts of one document sent in parallel would each see the set complete; one at a time, the
  // last one gathers it once
  return oneAtATime(`ingest:${context.userId}:${code}`, async () => {
    let body = String(args.markdown);
    if (parts > 1) {
      const gathered = await gather(
        deps,
        { owner: context.userId, docCode: code, parts },
        part,
        body,
      );
      if ("pending" in gathered) {
        return {
          ok: true,
          data: {
            result: "part_received",
            doc_code: code,
            part,
            parts,
            pending_parts: gathered.pending,
            note: `Parte ${part} de ${parts} recibida. Envía las partes ${gathered.pending.join(", ")} con el mismo doc_code y parts; con la última se arma y se encola sola.`,
          },
        };
      }
      // Gathered or too large, these parts are done; sent again, the upload starts from scratch
      await deps.storage.removeParts(context.userId, code).catch(() => {});
      if ("tooLarge" in gathered) {
        return refuse(
          "too_large",
          `El documento pasa de ${MAX_MARKDOWN_BYTES / 1024 / 1024} MB; divídelo en documentos más chicos.`,
        );
      }
      body = gathered.body;
    }

    const frontmatter = {
      doc_code: code,
      doc_title: args.doc_title,
      doc_version: args.doc_version,
      area,
      doc_revision: args.doc_revision,
      doc_type: args.doc_type,
      status: args.status,
      effective_date: args.effective_date,
      tags: args.tags ?? [],
    };
    const stored = await storeDocument(deps, writeDocument(frontmatter, body), {
      userId: context.userId,
      scopes: context.scopes,
      ip: null,
    });
    if (!stored.ok) {
      return refuse(stored.error, stored.message);
    }

    return {
      ok: true,
      data: {
        result: "queued",
        job_id: stored.jobId,
        doc_code: code,
        parts,
        frontmatter: stored.frontmatter,
        note:
          "El documento quedó GUARDADO y en cola para indexarse; todavía no está indexado. Da el " +
          "job_id y el doc_code tal cual y confirma con mode 'status' antes de decir que terminó.",
      },
    };
  });
}

/**
 * Changes only the metadata of a current document and queues its reindex; its code, version and
 * body stay, since a new version is a new upload
 *
 * @param   deps     Database, index and storage
 * @param   args     Code and the fields to change
 * @param   context  Who calls
 *
 * @return  The queued reindex, or why it was refused
 */
async function reclassify(
  deps: UploadDependencies,
  args: Args,
  context: ToolContext,
): Promise<ToolResult> {
  const code = args.doc_code;
  if (!code) {
    return refuse("missing_fields", "mode 'reclassify' necesita doc_code.");
  }

  const changes = Object.fromEntries(
    (["doc_title", "area", "doc_type", "status", "effective_date", "tags"] as const)
      .filter((field) => args[field] !== undefined)
      .map((field) => [field, args[field]]),
  );
  if (Object.keys(changes).length === 0) {
    return refuse(
      "missing_fields",
      "Indica qué cambiar: doc_title, area, doc_type, status, effective_date o tags.",
    );
  }
  if (args.area && !(await areaExists(deps.db, args.area))) {
    return refuse(
      "unknown_area",
      `El área ${args.area} no existe. Usa mode 'validate' para ver las áreas.`,
    );
  }
  // Only the current version: rewriting a superseded one would roll its document back
  if (!(await isCurrent(deps.index, code)) || !(await deps.storage.exists(code, "md"))) {
    return refuse(
      "document_not_found",
      `${code} no es la versión vigente de un documento cargado.`,
    );
  }

  const document = parseDocument(await deps.storage.readMarkdown(code));
  const before = document.frontmatter.area;
  // A document in an area the person does not read looks missing, so codes cannot be probed
  if (!context.scopes.has(areaScope(before))) {
    return refuse(
      "document_not_found",
      `${code} no es la versión vigente de un documento cargado.`,
    );
  }
  // Moving it also needs the area it reaches
  if (args.area && !context.scopes.has(areaScope(args.area))) {
    return refuse(
      "area_not_readable",
      `No lees el área ${args.area}, así que no puedes mover el documento ahí.`,
    );
  }

  // Checked as the worker will read it, before anything is saved
  let rewritten: string;
  try {
    rewritten = writeDocument({ ...document.frontmatter, ...changes }, document.body);
    parseDocument(rewritten);
  } catch (error) {
    return refuse("invalid_document", (error as Error).message);
  }

  const scope = areaScope(args.area ?? before);
  await deps.storage.save(code, "md", Buffer.from(rewritten, "utf8"), scope);

  // The PDF carries its own area; left behind, it would still open to the old readers
  if (args.area) {
    const original = await deps.storage.open(code, "pdf");
    if (original) {
      const pieces: Buffer[] = [];
      for await (const piece of original.stream) {
        pieces.push(piece as Buffer);
      }
      await deps.storage.save(code, "pdf", Buffer.concat(pieces), scope);
    }
  }

  // Deleted while this ran: what was just saved must not bring it back on the reindex
  if (!(await isCurrent(deps.index, code))) {
    await deps.storage.remove(code);
    return refuse("document_not_found", `${code} se borró mientras se cambiaba.`);
  }

  const jobId = await enqueue(deps.db, code, "reindex", context.userId);
  await logAudit(deps.db, {
    userId: context.userId,
    level: "info",
    eventCode: "docs.reclassified",
    message: `${code}: ${JSON.stringify(changes)}${args.area ? `, área ${before} → ${args.area}` : ""}`,
  });

  return {
    ok: true,
    data: {
      result: "queued",
      job_id: jobId,
      doc_code: code,
      changes,
      note:
        "Los datos quedaron GUARDADOS y el reindexado en cola; el cambio rige cuando termine. " +
        "Confirma con mode 'status'." +
        (args.area ? ` Desde entonces lo leen quienes tienen el área ${args.area}.` : ""),
    },
  };
}

/**
 * Reports how the indexing of a document went
 *
 * @param   deps     Database, index and storage
 * @param   args     Job id
 * @param   context  Who calls
 *
 * @return  The job status
 */
async function status(
  deps: UploadDependencies,
  args: Args,
  context: ToolContext,
): Promise<ToolResult> {
  if (!args.job_id) {
    return refuse("missing_fields", "mode 'status' necesita el job_id que devolvió 'ingest'.");
  }

  const job = await findJob(deps.db, args.job_id);
  // A job names its document; someone else's could be of an area this person does not read
  if (!job || job.userId !== context.userId) {
    return refuse("job_not_found", `No existe el job ${args.job_id}.`);
  }

  return {
    ok: true,
    data: {
      job_id: job.id,
      doc_code: job.docCode,
      status: job.status,
      detail: JOB_STATUS[job.status],
      chunks: job.chunks,
      error: job.error,
      created_at: job.createdAt.toISOString(),
      finished_at: job.finishedAt?.toISOString() ?? null,
      note:
        "Da el estado tal cual. Si sigue en cola o indexándose, dilo y vuelve a consultar; solo " +
        "'done' es éxito, con chunks exacto.",
    },
  };
}

/**
 * Builds the tool that loads a document from the conversation: the person attaches it, the model
 * converts it to markdown and the tool stores and indexes it through the same path as an upload
 *
 * @param   deps  Database, index and storage
 *
 * @return  The tool
 */
export function ingestTool(deps: UploadDependencies): Tool {
  return {
    definition: {
      name: INGEST,
      description:
        "Loads or updates a document of the organization's document search from the " +
        "conversation: the person attaches it (PDF or other) to the chat, you convert it to " +
        "markdown and this tool stores and indexes it. Use it when asked to upload, load, update " +
        "or index a document. Steps: (1) mode 'validate' with the fields you can infer from the " +
        "document; it says what to ask, whether a version is already loaded and how to convert; " +
        "(2) ask the person ONLY what is missing; (3) mode 'ingest' with the fields and the " +
        "markdown body, in parts with part and parts when long; (4) mode 'status' with the " +
        "job_id. Mode 'reclassify' changes only the title, area, type, status, date or tags of a " +
        "loaded document, without sending it again; a new version is a new ingest.",
      inputSchema: {
        type: "object",
        properties: {
          mode: { type: "string", enum: [...MODES] },
          doc_code: {
            type: "string",
            pattern: DOC_CODE.source,
            description: "Code with its version at the end, e.g. 'WAREHOUSE-GUIDE-V002'.",
          },
          doc_title: { type: "string", minLength: 1, maxLength: 300 },
          doc_version: { type: "string", minLength: 1, maxLength: 30, description: "e.g. 'V002'." },
          doc_revision: { type: "string", maxLength: 30 },
          area: {
            type: "string",
            pattern: "^[a-z0-9_-]{1,40}$",
            description: "Who can read it; 'validate' lists the areas.",
          },
          doc_type: { type: "string", maxLength: 60, description: "procedure, policy, manual..." },
          status: { type: "string", maxLength: 30 },
          effective_date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
          tags: {
            type: "array",
            maxItems: 30,
            items: { type: "string", minLength: 1, maxLength: 60 },
          },
          markdown: {
            type: "string",
            minLength: 1,
            maxLength: MAX_MARKDOWN_CHARS,
            description: "Document body in markdown, without frontmatter.",
          },
          part: { type: "integer", minimum: 1, maximum: MAX_PARTS },
          parts: { type: "integer", minimum: 1, maximum: MAX_PARTS },
          job_id: { type: "integer", minimum: 1 },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      requiredScopes: ["docs.manage"],
      readOnly: false,
    },
    execute: async (raw, context) => {
      const args = raw as Args;
      if (args.mode === "validate") {
        return validate(deps, args, context);
      }
      if (args.mode === "ingest") {
        return ingest(deps, args, context);
      }
      if (args.mode === "reclassify") {
        return reclassify(deps, args, context);
      }

      return status(deps, args, context);
    },
  };
}

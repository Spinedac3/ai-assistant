import { eq } from "drizzle-orm";
import { logAudit } from "../audit.js";
import type { Database } from "../db/client.js";
import { scopes } from "../db/schema.js";
import { areaScope, type Frontmatter, parseDocument } from "./document.js";
import { currentOfFamily, type Index, newerCurrent } from "./ingest.js";
import { enqueue } from "./jobs.js";
import type { DocumentStorage } from "./storage.js";

// A long manual in markdown stays well under this, however it arrives
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;

export interface UploadDependencies {
  db: Database;
  index: Index;
  storage: DocumentStorage;
}

export type Stored =
  | { ok: true; jobId: number; frontmatter: Frontmatter }
  | {
      ok: false;
      error: "invalid_document" | "unknown_area" | "area_not_readable" | "older_version";
      message: string;
    };

/**
 * Writes a frontmatter back as the flat YAML block the parser reads
 *
 * @param   frontmatter  Values by key
 * @param   body         Markdown body
 *
 * @return  The whole document
 */
export function writeDocument(frontmatter: Record<string, unknown>, body: string): string {
  // Double quotes and line breaks would end a value early in the flat reader, and a comma would
  // split a tag; a tag left blank is dropped by the reader
  const quote = (value: unknown) => `"${String(value).replace(/["\r\n]/g, " ")}"`;
  const lines = Object.entries(frontmatter)
    .filter(([, value]) => value !== undefined)
    .map(([name, value]) =>
      Array.isArray(value)
        ? `${name}: [${value
            .map((item) => String(item).replace(/,/g, " ").trim())
            .map(quote)
            .join(", ")}]`
        : `${name}: ${quote(value)}`,
    );

  return `---\n${lines.join("\n")}\n---\n${body}`;
}

/**
 * Tells whether an area exists as a read permission; a document of any other area nobody could read
 *
 * @param   db    Own database
 * @param   area  Area code
 *
 * @return  Whether it exists
 */
export async function areaExists(db: Database, area: string): Promise<boolean> {
  const [found] = await db
    .select({ id: scopes.id })
    .from(scopes)
    .where(eq(scopes.code, areaScope(area)));

  return found !== undefined;
}

/**
 * Lists the areas documents can belong to
 *
 * @param   db  Own database
 *
 * @return  Area codes
 */
export async function listAreas(db: Database): Promise<string[]> {
  const rows = await db.select({ code: scopes.code }).from(scopes);

  return rows
    .map((row) => row.code.match(/^docs\.(.+)\.read$/)?.[1])
    .filter((area): area is string => area !== undefined)
    .sort();
}

/**
 * Stores a document and queues its indexing: the one path the upload route and the chat share
 *
 * @param   deps      Database, index and storage
 * @param   markdown  Whole document with its frontmatter
 * @param   actor     Who uploads it, what they read, and from where
 * @param   original  PDF the markdown came from, if any
 *
 * @return  The queued job, or why the document was refused
 */
export async function storeDocument(
  deps: UploadDependencies,
  markdown: string,
  actor: { userId: number; scopes: ReadonlySet<string>; ip: string | null },
  original?: Buffer,
): Promise<Stored> {
  let parsed: ReturnType<typeof parseDocument>;
  try {
    parsed = parseDocument(markdown);
  } catch (error) {
    return { ok: false, error: "invalid_document", message: (error as Error).message };
  }

  const { frontmatter } = parsed;
  const scope = areaScope(frontmatter.area);
  if (!(await areaExists(deps.db, frontmatter.area))) {
    return {
      ok: false,
      error: "unknown_area",
      message: `El área ${frontmatter.area} no existe; créala primero como permiso ${scope}`,
    };
  }

  // Publishing reaches the target area and replaces the current versions of the family, so the
  // uploader must read every one of those areas; which areas they are is not told
  const current = await currentOfFamily(deps.index, frontmatter.doc_code);
  const reached = [scope, ...current.map((document) => document.required_scope)];
  if (reached.some((required) => !actor.scopes.has(required))) {
    return {
      ok: false,
      error: "area_not_readable",
      message: "Este documento toca un área que no lees, así que no puedes publicarlo.",
    };
  }

  const code = frontmatter.doc_code;
  const newer = await newerCurrent(deps.index, code);
  if (newer) {
    return {
      ok: false,
      error: "older_version",
      message: `Ya está vigente una versión más nueva (${newer}); sube una versión posterior`,
    };
  }

  // Each save replaces the object in one step, so a failure never leaves the document without
  // its markdown; an old PDF never stays next to a new markdown
  await deps.storage.save(code, "md", Buffer.from(markdown, "utf8"), scope);
  if (original) {
    await deps.storage.save(code, "pdf", original, scope);
  } else {
    await deps.storage.remove(code, ["pdf"]);
  }

  const jobId = await enqueue(deps.db, code, "upload", actor.userId);
  await logAudit(deps.db, {
    userId: actor.userId,
    level: "info",
    eventCode: "docs.uploaded",
    message: `${code} (${frontmatter.doc_title}), área ${frontmatter.area}`,
    ip: actor.ip,
  });

  return { ok: true, jobId, frontmatter };
}

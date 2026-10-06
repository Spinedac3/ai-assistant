import { z } from "zod";

const TARGET_CHUNK_CHARS = 600;
const MAX_CHUNK_CHARS = 1_500;

// Also the storage key of the original, so no path separators
export const DOC_CODE = /^[A-Za-z0-9._-]{1,100}$/;

// Editors on Windows often save it at the start of the file
const BOM = String.fromCodePoint(0xfeff);

const frontmatterSchema = z.object({
  doc_code: z.string().regex(DOC_CODE, "solo letras, números, punto, guion y guion bajo"),
  doc_title: z.string().trim().min(1).max(300),
  doc_version: z.string().trim().min(1).max(30),
  area: z.string().regex(/^[a-z0-9_-]{1,40}$/, "minúsculas, números, guion y guion bajo"),
  doc_revision: z.string().trim().max(30).optional(),
  doc_type: z.string().trim().max(60).optional(),
  status: z.string().trim().max(30).optional(),
  effective_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "formato AAAA-MM-DD")
    .optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(30).default([]),
});

export type Frontmatter = z.infer<typeof frontmatterSchema>;

export interface ParsedDocument {
  frontmatter: Frontmatter;
  body: string;
}

export interface Chunk {
  id: string;
  doc_code: string;
  doc_family: string;
  doc_title: string;
  doc_version: string;
  doc_revision?: string;
  doc_type?: string;
  section: string;
  section_path: string;
  text: string;
  page_number: number;
  chunk_index: number;
  required_scope: string;
  tags: string[];
  status?: string;
  effective_date?: string;
  is_current: boolean;
  updated_at: string;
}

/**
 * Names the scope that lets a person read the documents of an area
 *
 * @param   area  Area code
 *
 * @return  The scope code
 */
export function areaScope(area: string): string {
  return `docs.${area}.read`;
}

/**
 * Derives the family of a code: versions of one document share it, as in GUIDE-V001 and GUIDE-V002
 *
 * @param   docCode  Document code
 *
 * @return  The code without its -Vnnn suffix, or the whole code when it has none
 */
export function docFamily(docCode: string): string {
  return docCode.replace(/-V\d+$/i, "");
}

/**
 * Reads a flat YAML block: plain and quoted values and [a, b] lists, nothing nested
 *
 * @param   text  Lines between the --- marks
 *
 * @return  The values by key
 */
function readYaml(text: string): Record<string, unknown> {
  const values: Record<string, unknown> = {};

  for (const raw of text.split("\n")) {
    const [, name, rest = ""] = raw.trim().match(/^([a-zA-Z_][\w-]*):\s*(.*)$/) ?? [];
    if (!name) {
      continue;
    }

    const value = rest.trim();
    const unquote = (item: string) => item.replace(/^(["'])(.*)\1$/, "$2");

    values[name] =
      value.startsWith("[") && value.endsWith("]")
        ? value
            .slice(1, -1)
            .split(",")
            .map((item) => unquote(item.trim()))
            .filter(Boolean)
        : unquote(value);
  }

  return values;
}

/**
 * Splits a markdown file into its validated frontmatter and its body
 *
 * @param   raw  Whole file
 *
 * @return  The frontmatter and the body
 */
export function parseDocument(raw: string): ParsedDocument {
  const match = (raw.startsWith(BOM) ? raw.slice(1) : raw).match(
    /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/,
  );
  if (!match?.[1] || match[2] === undefined) {
    throw new Error("Falta el encabezado entre --- al inicio del archivo");
  }

  const parsed = frontmatterSchema.safeParse(readYaml(match[1]));
  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Encabezado inválido: ${problems.join("; ")}`);
  }

  return { frontmatter: parsed.data, body: match[2].replace(/\r\n/g, "\n") };
}

/**
 * Splits a line longer than a chunk at its last space before the limit; a paragraph converted
 * from a PDF often comes as one line, and a chunk the embedding service refuses fails the document
 *
 * @param   line  Line of the body
 *
 * @return  Pieces no longer than a chunk
 */
function splitLong(line: string): string[] {
  const pieces: string[] = [];
  let rest = line;

  while (rest.length > MAX_CHUNK_CHARS) {
    const space = rest.lastIndexOf(" ", MAX_CHUNK_CHARS);
    const cut = space > MAX_CHUNK_CHARS / 2 ? space : MAX_CHUNK_CHARS;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut).trimStart();
  }

  return [...pieces, rest];
}

/**
 * Cuts the body into chunks of about 600 characters, never across a heading or a page mark
 *
 * @param   document  Parsed document
 * @param   now       Indexing time
 *
 * @return  The chunks, numbered from 0
 */
export function chunkDocument(document: ParsedDocument, now = new Date()): Chunk[] {
  const { frontmatter: meta, body } = document;
  const chunks: Chunk[] = [];
  const headings = ["", "", "", ""];
  let buffer: string[] = [];
  let length = 0;
  let page = 1;

  const flush = () => {
    const text = buffer.join("\n").trim();
    buffer = [];
    length = 0;
    // Lone headings carry no answer; any other line does, however short, as a phone number
    if (text.split("\n").every((line) => line.trim() === "" || /^#{1,4}\s/.test(line))) {
      return;
    }

    const index = chunks.length;
    chunks.push({
      id: `${meta.doc_code}__${index}`,
      doc_code: meta.doc_code,
      doc_family: docFamily(meta.doc_code),
      doc_title: meta.doc_title,
      doc_version: meta.doc_version,
      doc_revision: meta.doc_revision,
      doc_type: meta.doc_type,
      section: headings[1] || headings[0] || "",
      section_path: headings.filter(Boolean).join(" > "),
      text,
      page_number: page,
      chunk_index: index,
      required_scope: areaScope(meta.area),
      tags: meta.tags,
      status: meta.status,
      effective_date: meta.effective_date ? `${meta.effective_date}T00:00:00Z` : undefined,
      is_current: true,
      updated_at: now.toISOString(),
    });
  };

  for (const line of body.split("\n").flatMap(splitLong)) {
    const pageMark = line.match(/^<!--\s*page:\s*(\d+)\s*-->\s*$/);
    if (pageMark?.[1]) {
      flush();
      page = Number.parseInt(pageMark[1], 10);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading?.[1] && heading[2]) {
      flush();
      const level = heading[1].length - 1;
      headings[level] = heading[2].trim();
      headings.fill("", level + 1);
    }

    // A line that would overflow the chunk starts the next one instead
    if (length > 0 && length + line.length + 1 > MAX_CHUNK_CHARS) {
      flush();
    }

    buffer.push(line);
    length += line.length + 1;

    // A blank line after the target is a natural cut; the maximum cuts anywhere
    if ((length >= TARGET_CHUNK_CHARS && line.trim() === "") || length >= MAX_CHUNK_CHARS) {
      flush();
    }
  }

  flush();

  return chunks;
}

/**
 * Builds the text that is embedded: the title and section go first so the vector carries the
 * context a lone passage lacks; the stored text stays as written
 *
 * @param   chunk  Chunk
 *
 * @return  The text to embed
 */
export function embeddingText(chunk: Chunk): string {
  const header = [chunk.doc_title, chunk.section_path].filter(Boolean).join(" — ");

  return header ? `${header}\n\n${chunk.text}` : chunk.text;
}

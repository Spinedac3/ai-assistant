import { chunkDocument, docFamily, embeddingText, type ParsedDocument } from "./document.js";
import type { Embedder } from "./embeddings.js";
import { escapeTerm, type Solr } from "./solr.js";

export interface Cores {
  // Current version of each document; the only one searches read
  current: string;
  // Superseded versions, kept for whoever needs the history
  historical: string;
}

export interface Index {
  solr: Solr;
  embedder: Embedder;
  cores: Cores;
}

export interface IngestResult {
  chunks: number;
  // Codes of the previous versions moved to the history
  superseded: string[];
}

// Solr internals that must not be posted back when a document is copied
const INTERNAL_FIELDS = ["_version_", "score"];

/**
 * Reads the version number of a code, as in GUIDE-V002; a code without one counts as version 0
 *
 * @param   docCode  Document code
 *
 * @return  The version number
 */
export function versionOf(docCode: string): number {
  return Number(docCode.match(/-V(\d+)$/i)?.[1] ?? 0);
}

/**
 * Finds a current version of the same family newer than a code, which must not be rolled back
 *
 * @param   index    Solr and cores
 * @param   docCode  Code about to become current
 *
 * @return  The newer code, or null
 */
export async function newerCurrent(index: Index, docCode: string): Promise<string | null> {
  const others = await index.solr.query<{ doc_code: string }>(index.cores.current, {
    query: `doc_family:${escapeTerm(docFamily(docCode))}`,
    filter: [`-doc_code:${escapeTerm(docCode)}`, "chunk_index:0"],
    fields: ["doc_code"],
    limit: 1_000,
  });

  return others.find((other) => versionOf(other.doc_code) > versionOf(docCode))?.doc_code ?? null;
}

/**
 * Tells whether a code is the current version of its document
 *
 * @param   index    Solr and cores
 * @param   docCode  Document code
 *
 * @return  Whether it has chunks in the current core
 */
export async function isCurrent(index: Index, docCode: string): Promise<boolean> {
  const hits = await index.solr.query(index.cores.current, {
    query: `doc_code:${escapeTerm(docCode)}`,
    fields: ["id"],
    limit: 1,
  });

  return hits.length > 0;
}

/**
 * Indexes a document as the current version of its family
 *
 * Its previous chunks go first, so a shorter new upload leaves no leftovers; the other versions of
 * the same family then move to the history with their vectors, so nothing is embedded twice. A
 * version older than the current one is refused: indexing it would roll the document back.
 *
 * @param   index     Solr, embedder and cores
 * @param   document  Parsed document
 *
 * @return  How many chunks were indexed and which versions were superseded
 */
export async function ingestDocument(
  index: Index,
  document: ParsedDocument,
): Promise<IngestResult> {
  const { solr, embedder, cores } = index;
  const docCode = document.frontmatter.doc_code;
  const chunks = chunkDocument(document);
  if (chunks.length === 0) {
    throw new Error("El documento no tiene texto para indexar");
  }

  const newer = await newerCurrent(index, docCode);
  if (newer) {
    throw new Error(`Ya está vigente una versión más nueva (${newer}); sube una versión posterior`);
  }

  // Embedded before anything is deleted: if the service is down, the indexed version stays
  const vectors = await embedder.passages(chunks.map(embeddingText));
  const code = escapeTerm(docCode);

  try {
    await solr.deleteWhere(cores.current, `doc_code:${code}`);
    await solr.add(
      cores.current,
      chunks.map((chunk, position) => ({ ...chunk, embedding: vectors[position] })),
    );
    await solr.commit(cores.current);
  } catch (error) {
    // Without this, the delete and the chunks already sent would go live with the next commit
    await solr.rollback(cores.current).catch(() => {});
    throw error;
  }

  // A code that was superseded once and comes back current must not stay in the history too
  await solr.deleteWhere(cores.historical, `doc_code:${code}`);
  await solr.commit(cores.historical);

  try {
    return { chunks: chunks.length, superseded: await supersede(index, docCode) };
  } catch (error) {
    throw new Error(
      `La versión nueva quedó indexada, pero no se pudo mover la anterior al histórico: ${(error as Error).message}`,
    );
  }
}

/**
 * Moves the other versions of a document's family from the current core to the history
 *
 * @param   index    Solr and cores
 * @param   docCode  Code of the version that stays current
 *
 * @return  The codes moved
 */
async function supersede(index: Index, docCode: string): Promise<string[]> {
  const { solr, cores } = index;
  const family = escapeTerm(docFamily(docCode));
  const older = await solr.query<Record<string, unknown>>(cores.current, {
    query: `doc_family:${family}`,
    filter: [`-doc_code:${escapeTerm(docCode)}`],
    fields: ["*"],
    limit: 100_000,
  });

  if (older.length === 0) {
    return [];
  }

  const codes = [...new Set(older.map((chunk) => String(chunk.doc_code)))];
  const copies = older.map((chunk) => {
    const copy: Record<string, unknown> = { ...chunk, is_current: false };
    for (const field of INTERNAL_FIELDS) {
      delete copy[field];
    }

    return copy;
  });

  await solr.add(cores.historical, copies);
  await solr.commit(cores.historical);
  await solr.deleteWhere(
    cores.current,
    `doc_family:${family} AND -doc_code:${escapeTerm(docCode)}`,
  );
  await solr.commit(cores.current);

  return codes;
}

/**
 * Retires the current version of a document from the search; its history stays for the record
 *
 * @param   index    Solr and cores
 * @param   docCode  Document code
 */
export async function removeDocument(index: Index, docCode: string): Promise<void> {
  await index.solr.deleteWhere(index.cores.current, `doc_code:${escapeTerm(docCode)}`);
  await index.solr.commit(index.cores.current);
}

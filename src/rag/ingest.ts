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

// Index writes of this process run one at a time: a commit or a rollback applies to the whole
// core, so a delete committed in the middle of an ingest would publish half a document
let writes: Promise<unknown> = Promise.resolve();

/**
 * Runs an index write after the ones already waiting
 *
 * @param   work  The write
 *
 * @return  Its result
 */
function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const run = writes.then(work, work);
  writes = run.catch(() => {});

  return run;
}

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

export interface CurrentDocument {
  doc_code: string;
  doc_title: string;
  doc_version: string;
  required_scope: string;
  updated_at: string;
}

/**
 * Lists the current documents of a code's family, newest version first
 *
 * @param   index    Solr and cores
 * @param   docCode  Any code of the family
 *
 * @return  One entry per current document
 */
export async function currentOfFamily(index: Index, docCode: string): Promise<CurrentDocument[]> {
  const found = await index.solr.query<CurrentDocument>(index.cores.current, {
    query: `doc_family:${escapeTerm(docFamily(docCode))}`,
    filter: ["chunk_index:0"],
    fields: ["doc_code", "doc_title", "doc_version", "required_scope", "updated_at"],
    limit: 1_000,
  });

  return found.sort((a, b) => versionOf(b.doc_code) - versionOf(a.doc_code));
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
  const others = await currentOfFamily(index, docCode);

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
 * @param   index     Solr, embedder and cores
 * @param   document  Parsed document
 *
 * @return  How many chunks were indexed and which versions were superseded
 */
export async function ingestDocument(
  index: Index,
  document: ParsedDocument,
): Promise<IngestResult> {
  // Its previous chunks go first, so a shorter new upload leaves no leftovers; the other versions of
  // the same family then move to the history with their vectors, so nothing is embedded twice. A
  // version older than the current one is refused: indexing it would roll the document back.
  const { solr, embedder, cores } = index;
  const docCode = document.frontmatter.doc_code;
  const chunks = chunkDocument(document);
  if (chunks.length === 0) {
    throw new Error("El documento no tiene texto para indexar");
  }

  // Embedded before taking the lock and before anything is deleted: the slow part blocks no other
  // write, and if the service is down the indexed version stays
  const vectors = await embedder.passages(chunks.map(embeddingText));
  const code = escapeTerm(docCode);

  return exclusive(async () => {
    const newer = await newerCurrent(index, docCode);
    if (newer) {
      throw new Error(
        `Ya está vigente una versión más nueva (${newer}); sube una versión posterior`,
      );
    }

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

    try {
      // A code that was superseded once and comes back current must not stay in the history too
      await solr.deleteWhere(cores.historical, `doc_code:${code}`);
      await solr.commit(cores.historical);

      return { chunks: chunks.length, superseded: await supersede(index, docCode) };
    } catch (error) {
      throw new Error(
        `La versión nueva quedó indexada, pero no se pudo poner en orden el histórico: ${(error as Error).message}`,
      );
    }
  });
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
  await exclusive(async () => {
    await index.solr.deleteWhere(index.cores.current, `doc_code:${escapeTerm(docCode)}`);
    await index.solr.commit(index.cores.current);
  });
}

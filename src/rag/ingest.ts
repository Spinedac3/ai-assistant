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
 * Indexes a document as the current version of its family
 *
 * Its previous chunks go first, so a shorter new upload leaves no leftovers; older versions of the
 * same family then move to the history with their vectors, so nothing is embedded twice.
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
  const chunks = chunkDocument(document);
  if (chunks.length === 0) {
    throw new Error("El documento no tiene texto para indexar");
  }

  // Embedded before anything is deleted: if the service is down, the indexed version stays
  const vectors = await embedder.passages(chunks.map(embeddingText));
  const code = escapeTerm(document.frontmatter.doc_code);

  await solr.deleteWhere(cores.current, `doc_code:${code}`);
  await solr.add(
    cores.current,
    chunks.map((chunk, position) => ({ ...chunk, embedding: vectors[position] })),
  );
  await solr.commit(cores.current);

  return {
    chunks: chunks.length,
    superseded: await supersede(index, document.frontmatter.doc_code),
  };
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
 * Deletes a document from the current core
 *
 * @param   index    Solr and cores
 * @param   docCode  Document code
 */
export async function removeDocument(index: Index, docCode: string): Promise<void> {
  await index.solr.deleteWhere(index.cores.current, `doc_code:${escapeTerm(docCode)}`);
  await index.solr.commit(index.cores.current);
}

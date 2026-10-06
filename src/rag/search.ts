import type { Index } from "./ingest.js";
import { parentBlock } from "./parent.js";
import { escapeTerm } from "./solr.js";

// Candidates each ranking brings; a wide pool gives the fusion material to work with
const POOL = 50;
// Standard RRF constant: damps the top positions so a lone first place does not crush a document
// ranked well in both lists
const RRF_K = 60;
// Meaning weighs more because real questions are natural language; words carry codes and acronyms
const DENSE_WEIGHT = 0.6;
const LEXICAL_WEIGHT = 0.4;
// With 1/RRF_K a score could add at most what one list position adds, too little to break a tie
const SCORE_SCALE = 2 / RRF_K;
const SNIPPET_CHARS = 300;
// Siblings read to rebuild a section; more than fits in the parent block anyway
const SIBLINGS = 60;

const FIELDS = [
  "id",
  "doc_code",
  "doc_title",
  "section",
  "section_path",
  "text",
  "page_number",
  "chunk_index",
  "score",
];

const DOC_SCOPE = /^docs\.[a-z0-9_-]+\.read$/;
// Letters and digits joined by separators, as in BOD-PRO-V001; a number, year or decimal is no code
const SINGLE_CODE = /^(?=.*[A-Za-z])[A-Za-z0-9]+(?:[-_.][A-Za-z0-9]+)+$/;
// Solr reads these words as operators; a question saying "or" must still be a question
const OPERATORS = new Set(["AND", "OR", "NOT"]);

export interface Hit {
  id: string;
  doc_code: string;
  doc_title: string;
  section?: string;
  section_path?: string;
  text: string;
  page_number?: number;
  chunk_index: number;
  score: number;
}

interface Candidate {
  hit: Hit;
  rank: number;
  dense?: number;
  lexical?: number;
}

export type SearchStatus = "ok" | "no_results" | "no_access" | "unavailable";

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  snippet: string;
}

export interface FetchedDocument {
  id: string;
  title: string;
  text: string;
  url: string;
  metadata: Record<string, unknown>;
}

/**
 * Builds the row filter from the document scopes of a person, so neither ranking ever returns a
 * chunk of an area they cannot read
 *
 * @param   scopes  Effective scopes
 *
 * @return  The filter, or null when the person reads no area
 */
export function scopeFilter(scopes: ReadonlySet<string>): string | null {
  const areas = [...scopes].filter((scope) => DOC_SCOPE.test(scope)).sort();

  return areas.length === 0 ? null : `required_scope:(${areas.map(escapeTerm).join(" OR ")})`;
}

/**
 * Builds the word query: title counts double, section one and a half, and the code eight times,
 * since asking for a code is asking for that document, not one that mentions it
 *
 * @param   question  Question as written
 *
 * @return  The Solr query
 */
export function wordQuery(question: string): string {
  const terms = question
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => (OPERATORS.has(term) ? `"${term}"` : escapeTerm(term)))
    .join(" ");
  if (terms === "") {
    return "*:*";
  }

  return `text:(${terms}) doc_code:(${terms})^8 doc_title:(${terms})^2 section:(${terms})^1.5`;
}

/**
 * Min-max range of a ranking's scores over the whole pool; fewer than two distinct values carry
 * no relative information, so that signal is skipped
 *
 * @param   scores  Scores of one ranking
 *
 * @return  The range, or null
 */
function rangeOf(scores: readonly number[]): { min: number; max: number } | null {
  if (scores.length < 2) {
    return null;
  }

  const min = Math.min(...scores);
  const max = Math.max(...scores);

  return max === min ? null : { min, max };
}

/**
 * Runs the hybrid search and returns the candidates best first
 *
 * @param   index     Solr, embedder and cores
 * @param   filter    Row filter of the person
 * @param   question  Question as written
 *
 * @return  The ranked hits
 */
async function hybrid(index: Index, filter: string, question: string): Promise<Hit[]> {
  // The word query starts while the question is embedded; both rankings merge by position (RRF),
  // which ignores their unrelated scales, and the normalized score of each is then added on top,
  // because position alone ranks the first place of a 0.95 match the same as one of 0.55. Without
  // the embedding service, or when the vector query fails, the search goes on with words only.
  const { solr, embedder, cores } = index;

  // A question that is exactly one code asks for that document; it is a filter, not a ranking
  const code = question.trim();
  if (SINGLE_CODE.test(code)) {
    const exact = await solr.query<Hit>(cores.current, {
      query: `doc_code:(${escapeTerm(code)} OR ${escapeTerm(code.toUpperCase())})`,
      filter: [filter],
      fields: FIELDS,
      sort: "chunk_index asc",
      limit: POOL,
    });
    if (exact.length > 0) {
      return exact;
    }
  }

  const words = solr.query<Hit>(cores.current, {
    query: wordQuery(question),
    filter: [filter],
    fields: FIELDS,
    limit: POOL,
  });
  // Handled now so a failure while the question is embedded is not an unhandled rejection
  words.catch(() => {});

  const vector = await embedder.query(question);
  const meaning = vector
    ? solr
        .query<Hit>(cores.current, {
          query: `{!knn f=embedding topK=${POOL}}[${vector.join(",")}]`,
          filter: [filter],
          fields: FIELDS,
          limit: POOL,
        })
        .catch(() => [])
    : Promise.resolve([]);
  const [lexical, dense] = await Promise.all([words, meaning]);

  const candidates = new Map<string, Candidate>();
  const collect = (hits: Hit[], signal: "dense" | "lexical") => {
    hits.forEach((hit, position) => {
      const candidate = candidates.get(hit.id) ?? { hit, rank: 0 };
      candidate.rank += 1 / (RRF_K + position + 1);
      candidate[signal] = hit.score;
      candidates.set(hit.id, candidate);
    });
  };
  // Words first: ties keep insertion order, and this order is the one the rankings were measured on
  collect(lexical, "lexical");
  collect(dense, "dense");

  const addMagnitude = (
    read: (candidate: Candidate) => number | undefined,
    weight: number,
    range: { min: number; max: number } | null,
  ) => {
    if (!range) {
      return;
    }

    for (const candidate of candidates.values()) {
      const score = read(candidate);
      if (score !== undefined) {
        const normalized = (score - range.min) / (range.max - range.min);
        candidate.rank += Math.min(1, Math.max(0, normalized)) * weight * SCORE_SCALE;
      }
    }
  };
  addMagnitude(
    (candidate) => candidate.dense,
    DENSE_WEIGHT,
    rangeOf(dense.map((hit) => hit.score)),
  );
  addMagnitude(
    (candidate) => candidate.lexical,
    LEXICAL_WEIGHT,
    rangeOf(lexical.map((hit) => hit.score)),
  );

  return [...candidates.values()].sort((a, b) => b.rank - a.rank).map((candidate) => candidate.hit);
}

/**
 * Names a hit for the person: title, section and code
 *
 * @param   hit  Hit
 *
 * @return  The title
 */
function titleOf(hit: Hit): string {
  const section = hit.section_path || hit.section || "";

  return `${hit.doc_title}${section ? ` — ${section}` : ""} (${hit.doc_code})`;
}

/**
 * Searches the documents a person can read and returns short passages to choose from
 *
 * @param   index     Solr, embedder and cores
 * @param   scopes    Effective scopes of the person
 * @param   question  Question as written
 * @param   limit     How many passages
 *
 * @return  The status and the passages
 */
export async function searchDocuments(
  index: Index,
  scopes: ReadonlySet<string>,
  question: string,
  limit = 10,
): Promise<{ status: SearchStatus; results: SearchResult[] }> {
  // There is no relevance floor on purpose: the reader is a model that sees the snippets and
  // decides which to fetch, and the statuses tell an empty result from a failure to check.
  const filter = scopeFilter(scopes);
  if (!filter) {
    return { status: "no_access", results: [] };
  }

  let hits: Hit[];
  try {
    hits = await hybrid(index, filter, question);
  } catch {
    return { status: "unavailable", results: [] };
  }

  const results = hits.slice(0, limit).map((hit) => ({
    id: hit.id,
    title: titleOf(hit),
    url: "",
    snippet: hit.text.length > SNIPPET_CHARS ? `${hit.text.slice(0, SNIPPET_CHARS)}…` : hit.text,
  }));

  return { status: results.length === 0 ? "no_results" : "ok", results };
}

/**
 * Returns a passage by id together with the section it belongs to
 *
 * @param   index   Solr, embedder and cores
 * @param   scopes  Effective scopes of the person
 * @param   id      Passage id
 *
 * @return  The status and the document
 */
export async function fetchPassage(
  index: Index,
  scopes: ReadonlySet<string>,
  id: string,
): Promise<{ status: SearchStatus | "not_found"; document: FetchedDocument | null }> {
  // The id is checked with the same row filter as the search, so an id the person cannot read
  // resolves to nothing, exactly like one that does not exist.
  const filter = scopeFilter(scopes);
  if (!filter) {
    return { status: "no_access", document: null };
  }

  const { solr, cores } = index;
  let hit: Hit | undefined;
  try {
    [hit] = await solr.query<Hit>(cores.current, {
      query: `id:${escapeTerm(id)}`,
      filter: [filter],
      fields: FIELDS,
      limit: 1,
    });
  } catch {
    return { status: "unavailable", document: null };
  }

  if (!hit) {
    return { status: "not_found", document: null };
  }

  // A chunk without a section belongs to a short document, so the whole document is its parent
  const section = hit.section_path || "";
  const parent = section
    ? `doc_code:${escapeTerm(hit.doc_code)} AND section_path:${escapeTerm(section)}`
    : `doc_code:${escapeTerm(hit.doc_code)}`;
  let siblings: Hit[] = [];
  try {
    siblings = await solr.query<Hit>(cores.current, {
      query: parent,
      filter: [filter],
      fields: FIELDS,
      sort: "chunk_index asc",
      limit: SIBLINGS,
    });
  } catch {
    // The chunk alone is still an answer; the section is an improvement over it
  }

  const block = siblings.length > 1 ? parentBlock(siblings, hit.chunk_index) : null;

  return {
    status: "ok",
    document: {
      id: hit.id,
      title: titleOf(hit),
      text: block?.text || hit.text,
      url: "",
      metadata: {
        doc_code: hit.doc_code,
        section,
        page: hit.page_number,
        ...(block ? { pieces: block.pieces, cut: block.cut } : {}),
      },
    },
  };
}

import { describe, expect, it } from "vitest";
import { type Embedder, roundVector } from "../../src/rag/embeddings.js";
import type { Index } from "../../src/rag/ingest.js";
import { type Hit, scopeFilter, searchDocuments, wordQuery } from "../../src/rag/search.js";
import { escapeTerm, Solr, type SolrQuery } from "../../src/rag/solr.js";

const READER = new Set(["docs.general.read"]);

/**
 * Builds a hit with a score
 *
 * @param   id     Chunk id
 * @param   score  Score of its ranking
 *
 * @return  The hit
 */
function hit(id: string, score: number): Hit {
  return { id, doc_code: id, doc_title: id, text: id, chunk_index: 0, score };
}

/**
 * Builds a Solr that answers each ranking with fixed hits and records exact code lookups
 *
 * @param   hits  Hits of the word and meaning rankings
 *
 * @return  The stub
 */
function stubSolr(hits: { lexical: Hit[]; dense: Hit[] }) {
  return new (class extends Solr {
    exactQueries: string[] = [];

    override async query<T>(_core: string, query: SolrQuery): Promise<T[]> {
      if (query.query.startsWith("doc_code:(")) {
        this.exactQueries.push(
          query.query.replace(/^doc_code:\((\S+) OR .*$/, "$1").replace(/\\/g, ""),
        );
        return [];
      }

      return (query.query.startsWith("{!knn") ? hits.dense : hits.lexical) as T[];
    }
  })("http://unused");
}

/**
 * Builds an index on a stub Solr and an embedder that always answers
 *
 * @param   solr  Stub Solr
 *
 * @return  The index
 */
function stubIndex(solr: Solr): Index {
  const embedder = { query: async () => [0.1] } as unknown as Embedder;

  return { solr, embedder, cores: { current: "docs", historical: "history" } };
}

describe("search", () => {
  it("filters by the document areas of the person and nothing else", () => {
    // Performs the test.
    const filter = scopeFilter(
      new Set(["chat.use", "docs.rrhh.read", "docs.general.read", "docs.manage", "docs.x.read.y"]),
    );

    // Performs assertions.
    expect(filter).toBe("required_scope:(docs.general.read OR docs.rrhh.read)");
    expect(scopeFilter(new Set(["chat.use", "docs.manage"]))).toBeNull();
  });

  it("weighs the code, title and section above the text", () => {
    // Performs assertions.
    expect(wordQuery("plazo  devolución")).toBe(
      "text:(plazo devolución) doc_code:(plazo devolución)^8 doc_title:(plazo devolución)^2 section:(plazo devolución)^1.5",
    );
    expect(wordQuery("   ")).toBe("*:*");
  });

  it("escapes every character Solr reads as syntax", () => {
    // Performs the test.
    const escaped = escapeTerm('a+b-c!(d){e}[f]^"g"~*?:\\/&| h');

    // Performs assertions.
    expect(escaped).toBe(
      'a\\+b\\-c\\!\\(d\\)\\{e\\}\\[f\\]\\^\\"g\\"\\~\\*\\?\\:\\\\\\/\\&\\|\\ h',
    );
    expect(wordQuery("x) OR (*:*")).toBe(
      'text:(x\\) "OR" \\(\\*\\:\\*) doc_code:(x\\) "OR" \\(\\*\\:\\*)^8 doc_title:(x\\) "OR" \\(\\*\\:\\*)^2 section:(x\\) "OR" \\(\\*\\:\\*)^1.5',
    );
    expect(wordQuery("AND or NOT")).toBe(
      'text:("AND" or "NOT") doc_code:("AND" or "NOT")^8 doc_title:("AND" or "NOT")^2 section:("AND" or "NOT")^1.5',
    );
  });

  it("ranks meaning above words and the magnitude above a tie of positions", async () => {
    // Performs the test.
    // X leads meaning, Y leads words, Z is second in both: positions alone would put Z first
    const solr = stubSolr({
      lexical: [hit("Y", 10), hit("Z", 1)],
      dense: [hit("X", 0.9), hit("Z", 0.1)],
    });
    const { results } = await searchDocuments(stubIndex(solr), READER, "pregunta cualquiera");

    // Performs assertions.
    expect(results.map((result) => result.id)).toEqual(["X", "Z", "Y"]);
  });

  it("tries the exact code only for a question that looks like one", async () => {
    // Performs the test.
    const solr = stubSolr({ lexical: [hit("A", 1)], dense: [] });
    for (const question of ["2024", "15", "1.5", "devoluciones", "BOD-PRO-V001"]) {
      await searchDocuments(stubIndex(solr), READER, question);
    }

    // Performs assertions.
    expect(solr.exactQueries).toEqual(["BOD-PRO-V001"]);
  });

  it("rounds vectors to six decimals", () => {
    // Performs assertions.
    expect(roundVector([0.1234567891, -0.0000004, 1])).toEqual([0.123457, -0, 1]);
  });
});

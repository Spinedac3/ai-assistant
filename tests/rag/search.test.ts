import { describe, expect, it } from "vitest";
import { roundVector } from "../../src/rag/embeddings.js";
import { scopeFilter, wordQuery } from "../../src/rag/search.js";
import { escapeTerm } from "../../src/rag/solr.js";

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
      "text:(x\\) OR \\(\\*\\:\\*) doc_code:(x\\) OR \\(\\*\\:\\*)^8 doc_title:(x\\) OR \\(\\*\\:\\*)^2 section:(x\\) OR \\(\\*\\:\\*)^1.5",
    );
  });

  it("rounds vectors to six decimals", () => {
    // Performs assertions.
    expect(roundVector([0.1234567891, -0.0000004, 1])).toEqual([0.123457, -0, 1]);
  });
});

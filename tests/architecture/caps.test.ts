import { describe, expect, it } from "vitest";
import { type SchemaCap, schemaCaps } from "./support/caps.js";
import { type SourceFile, sourceFiles } from "./support/source.js";

// The one bound on rows is by size, in the registry, which keeps the whole detail as an Excel.
// A row count a model can ask for, or a query that stops early, cuts before that can happen and
// teaches the model to page by hand.
const ROW_PARAMETER = /^\s+"?(limit|top|max_rows|page|page_size|per_page|offset)"?:\s*\{/m;
const EARLY_STOP = /\bLIMIT\b|\bTOP\b|\bFETCH\s+(NEXT|FIRST)\b/i;
const PAGING_TEXT =
  /next page|paginat|page_size|página siguiente|at most \d+ rows|máximo \d+ filas/i;
// A list of people is never cut short: a notice goes to whoever needs it
const PEOPLE = /notices|recipients|emails/;
const MIN_PEOPLE = 200;

// Every bound a tool's input declares, with why it is that number. One not here does not get in,
// one does not go lower, and one removed leaves the list in the same change.
const CAPS_WITH_REASON: Record<string, { max: number; why: string }> = {
  "calculate.ts:expression.maxLength": { max: 200, why: "an expression, not a program" },
  "documents.ts:query.maxLength": { max: 500, why: "a question as a person asks it" },
  "documents.ts:id.maxLength": { max: 200, why: "passage ids are a code and a number" },
  "ingest.ts:doc_title.maxLength": { max: 300, why: "the document title column" },
  "ingest.ts:doc_version.maxLength": { max: 30, why: "the version column" },
  "ingest.ts:doc_revision.maxLength": { max: 30, why: "the revision column" },
  "ingest.ts:doc_type.maxLength": { max: 60, why: "the type column" },
  "ingest.ts:status.maxLength": { max: 30, why: "the status column" },
  "ingest.ts:tags.maxItems": { max: 30, why: "tags filter a search; more stop meaning anything" },
  "ingest.ts:tags.items.maxLength": { max: 60, why: "a tag is a word or two" },
  "ingest.ts:markdown.maxLength": {
    max: 400_000,
    why: "what one call carries; longer goes in parts",
  },
  "ingest.ts:part.maximum": { max: 30, why: "parts of one document upload" },
  "ingest.ts:parts.maximum": { max: 30, why: "parts of one document upload" },
  "readPdf.ts:question.maxLength": { max: 2_000, why: "a question about a file" },
  "sendNotice.ts:notices.maxItems": { max: 200, why: "people: two hundred or more" },
  "sendNotice.ts:notices.items.to.maxLength": { max: 255, why: "the longest email address" },
  "sendNotice.ts:notices.items.subject.maxLength": { max: 200, why: "a mail subject line" },
  "sendNotice.ts:notices.items.message.maxLength": { max: 20_000, why: "a notice, not a report" },
  "tool.ts:value.maxItems": { max: 2, why: "a range has two ends" },
  "capabilities.ts:top_k.maximum": { max: 15, why: "tools to choose from, not rows of data" },
};

interface CapsVerdict {
  rowParameters: string[];
  unexplained: string[];
  lowered: string[];
  gone: string[];
  shortPeople: string[];
  earlyStop: boolean;
  pagingText: string[];
}

/**
 * Checks the bounds of the tools: a pure function, so the cases below can feed it
 *
 * @param   tools      Files that declare tool inputs
 * @param   query      Source of the function that builds a created tool's query
 * @param   prompts    Files whose strings a model reads
 * @param   reasons    Bounds with their reason
 *
 * @return  What breaks each rule
 */
function capsVerdict(
  tools: SourceFile[],
  query: string,
  prompts: SourceFile[],
  reasons: Record<string, { max: number; why: string }>,
): CapsVerdict {
  const caps: SchemaCap[] = tools.flatMap((file) =>
    schemaCaps(file.path.split("/").pop() ?? "", file.text),
  );
  const keys = new Set(caps.map((cap) => cap.key));

  return {
    rowParameters: tools.filter((file) => ROW_PARAMETER.test(file.text)).map((file) => file.path),
    unexplained: caps.filter((cap) => !(cap.key in reasons)).map((cap) => cap.key),
    lowered: caps
      .filter((cap) => {
        const known = reasons[cap.key];
        return known !== undefined && !(cap.value >= known.max);
      })
      .map((cap) => `${cap.key}: ${cap.value} < ${reasons[cap.key]?.max}`),
    gone: Object.keys(reasons).filter((key) => !keys.has(key)),
    shortPeople: caps
      .filter(
        (cap) => PEOPLE.test(cap.key) && cap.key.endsWith(".maxItems") && cap.value < MIN_PEOPLE,
      )
      .map((cap) => cap.key),
    earlyStop: EARLY_STOP.test(query),
    pagingText: prompts.flatMap((file) =>
      [...file.text.matchAll(/"[^"\n]*"|`[^`]*`/g)]
        .filter((text) => PAGING_TEXT.test(text[0]))
        .map((text) => `${file.path}: ${text[0].slice(0, 80)}`),
    ),
  };
}

/**
 * Cuts the source of one exported function out of its file
 *
 * @param   text  File contents
 * @param   name  Function name
 *
 * @return  Its source up to the next top-level declaration
 */
function functionSource(text: string, name: string): string {
  const start = text.indexOf(`export function ${name}(`);
  const end = text.slice(start + 1).search(/\n(export )?(async )?function /);

  return start < 0 ? "" : text.slice(start, end < 0 ? undefined : start + 1 + end);
}

describe("caps", () => {
  const tools = [
    ...sourceFiles("src/tools/native"),
    ...sourceFiles("src/creator").filter((file) => file.path.endsWith("/tool.ts")),
    ...sourceFiles("src/mcp").filter((file) => file.path.endsWith("/capabilities.ts")),
  ];
  const sql = sourceFiles("src/creator").find((file) => file.path.endsWith("/sql.ts"));
  const query = functionSource(sql?.text ?? "", "buildQuery");
  const prompts = ["src/tools", "src/creator", "src/chat", "src/mcp", "src/llm"].flatMap((folder) =>
    sourceFiles(folder),
  );
  const found = capsVerdict(tools, query, prompts, CAPS_WITH_REASON);

  it("offers a model no row count, page or offset to ask for", () => {
    // Performs assertions.
    expect(found.rowParameters, "Las filas se acotan por tamaño en el registro").toEqual([]);
  });

  it("lets a created tool's query bring every row it matches", () => {
    // Performs assertions.
    expect(query).toContain("export function buildQuery(");
    expect(found.earlyStop, "La consulta de una herramienta no corta filas").toBe(false);
  });

  it("explains every bound of a tool's input, and never lowers one", () => {
    // Performs assertions.
    expect(found.unexplained, "Un tope sin razón escrita no entra").toEqual([]);
    expect(found.lowered, "Un tope no baja").toEqual([]);
    expect(found.gone, "Ya no tiene tope: quítalo de la lista").toEqual([]);
  });

  it("takes at least two hundred people in a list of them", () => {
    // Performs assertions.
    expect(found.shortPeople).toEqual([]);
  });

  it("never tells a model to page through results", () => {
    // Performs assertions.
    expect(found.pagingText, "El detalle completo viaja en el Excel").toEqual([]);
  });
});

describe("caps, fed a breach of each rule", () => {
  it("names each breach and lets healthy bounds through", () => {
    // Performs the test.
    const tool = {
      path: "src/tools/native/list.ts",
      text: [
        "const MAX = 1_000;",
        "inputSchema: {",
        "  properties: {",
        '    limit: { type: "integer" },',
        '    question: { type: "string", maxLength: MAX },',
        '    title: { type: "string", maxLength: 50 },',
        '    recipients: { type: "array", maxItems: 20 },',
        "  },",
        "},",
      ].join("\n"),
    };
    const quoted = {
      path: "src/tools/native/paged.ts",
      text: [
        "inputSchema: {",
        "  properties: {",
        '    "page_size": { type: "integer" },',
        "  },",
        "},",
      ].join("\n"),
    };
    const found = capsVerdict(
      [tool, quoted],
      "SELECT TOP 100 * FROM base",
      [
        {
          path: "src/chat/prompt.ts",
          text: 'const hint = "Ask for the next page when there are more";',
        },
      ],
      {
        "list.ts:question.maxLength": { max: 2_000, why: "a question" },
        "list.ts:recipients.maxItems": { max: 20, why: "people" },
        "list.ts:gone.maxLength": { max: 10, why: "removed" },
      },
    );

    // Performs assertions.
    expect(found.rowParameters).toEqual(["src/tools/native/list.ts", "src/tools/native/paged.ts"]);
    expect(found.unexplained).toEqual(["list.ts:title.maxLength"]);
    expect(found.lowered).toEqual(["list.ts:question.maxLength: 1000 < 2000"]);
    expect(found.gone).toEqual(["list.ts:gone.maxLength"]);
    expect(found.shortPeople).toEqual(["list.ts:recipients.maxItems"]);
    expect(found.earlyStop).toBe(true);
    expect(found.pagingText).toEqual([
      'src/chat/prompt.ts: "Ask for the next page when there are more"',
    ]);
  });
});

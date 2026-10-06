import ts from "typescript";
import { describe, expect, it } from "vitest";
import { commentsOf, type SourceFile, sourceFiles } from "./support/source.js";

// A comment explains why the code is the way it is; when or for whom lives in the history
const CITATIONS: Array<[string, RegExp]> = [
  ["fecha", /\b\d{4}-\d{2}-\d{2}\b/],
  ["issue", /(^|[\s(])#\d+\b/],
  ["decisión", /\bD\d{1,3}\b/],
  ["pendiente", /\b(TODO|FIXME|XXX)\b/],
];
// Words only a Spanish sentence has; quoted text is an example and does not count
const SPANISH = /[¿¡]|\b(que|para|los|las|una|por|cuando|también|está|porque|pero|esto)\b/i;
const QUOTED = /"[^"]*"|'[^']*'|`[^`]*`|«[^»]*»/g;

interface CommentVerdict {
  cited: string[];
  spanish: string[];
  longDocblocks: string[];
  testsWithoutAssertions: string[];
}

/**
 * Tells whether a docblock describes in more than one paragraph before its tags
 *
 * @param   comment  The comment
 *
 * @return  Whether it does
 */
function describesAtLength(comment: string): boolean {
  if (!comment.startsWith("/**")) {
    return false;
  }
  const lines = comment
    .replace(/^\/\*\*|\*\/$/g, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\*\s?/, ""));
  const tag = lines.findIndex((line) => line.trim().startsWith("@"));
  const description = lines
    .slice(0, tag < 0 ? undefined : tag)
    .join("\n")
    .trim();

  return description.split(/\n\s*\n/).length > 1;
}

/**
 * Lists the tests of a file whose body never reaches its assertions marker
 *
 * @param   file  Test file
 *
 * @return  The names of those tests
 */
function testsWithoutMarker(file: SourceFile): string[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  const missing: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      /^(it|test)$/.test(node.expression.getText()) &&
      node.arguments.length >= 2 &&
      !(node.arguments[1]?.getText() ?? "").includes("// Performs assertions.")
    ) {
      missing.push(`${file.path}: ${node.arguments[0]?.getText()}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return missing;
}

/**
 * Checks the comments of some files: a pure function, so the cases below can feed it
 *
 * @param   files  Files with their path
 *
 * @return  The comments and tests breaking each rule
 */
function commentVerdict(files: SourceFile[]): CommentVerdict {
  const verdict: CommentVerdict = {
    cited: [],
    spanish: [],
    longDocblocks: [],
    testsWithoutAssertions: [],
  };
  for (const file of files) {
    for (const comment of commentsOf(file.text, file.path)) {
      const where = `${file.path}:${comment.line}`;
      for (const [kind, citation] of CITATIONS) {
        if (citation.test(comment.text)) {
          verdict.cited.push(`${where} (${kind})`);
        }
      }
      if (SPANISH.test(comment.text.replace(QUOTED, ""))) {
        verdict.spanish.push(where);
      }
      if (describesAtLength(comment.text)) {
        verdict.longDocblocks.push(where);
      }
    }
    if (file.path.endsWith(".test.ts")) {
      verdict.testsWithoutAssertions.push(...testsWithoutMarker(file));
    }
  }

  return verdict;
}

describe("comments", () => {
  const found = commentVerdict([
    ...sourceFiles("src"),
    ...sourceFiles("tests"),
    ...sourceFiles("web/src"),
    ...sourceFiles("web/src", ".tsx"),
  ]);

  it("never cites a date, an issue, a decision or a pending task", () => {
    // Performs assertions.
    expect(found.cited, "El porqué va en el comentario; el cuándo, en el historial").toEqual([]);
  });

  it("writes comments in English", () => {
    // Performs assertions.
    expect(found.spanish, "Comentarios en inglés; en español solo lo que lee una persona").toEqual(
      [],
    );
  });

  it("describes in one paragraph in a docblock, and leaves the why to comments in the body", () => {
    // Performs assertions.
    expect(found.longDocblocks).toEqual([]);
  });

  it("marks where every test asserts", () => {
    // Performs assertions.
    expect(found.testsWithoutAssertions).toEqual([]);
  });
});

describe("comments, fed a breach of each rule", () => {
  it("names each breach and lets healthy comments through", () => {
    // Performs the test.
    const found = commentVerdict([
      {
        path: "a.ts",
        text: [
          "// Decided on 2026-01-05",
          "// See #12",
          "// As D41 says",
          "// TODO: split",
          "// Esto es para los clientes",
          '// Shown as "la del asistente", a quoted example',
          "/**",
          " * Reads a file",
          " *",
          " * Because the disk is slow.",
          " *",
          " * @param   path  File",
          " */",
          "function read(path: string) {",
          '  return "// not a comment, 2026-01-05";',
          "}",
        ].join("\n"),
      },
      {
        path: "a.test.ts",
        text: [
          'it("asserts", () => {',
          "  // Performs assertions.",
          "  expect(1).toBe(1);",
          "});",
          'it("forgets", () => {',
          "  expect(1).toBe(1);",
          "});",
        ].join("\n"),
      },
    ]);

    // Performs assertions.
    expect(found.cited).toEqual([
      "a.ts:1 (fecha)",
      "a.ts:2 (issue)",
      "a.ts:3 (decisión)",
      "a.ts:4 (pendiente)",
    ]);
    expect(found.spanish).toEqual(["a.ts:5"]);
    expect(found.longDocblocks).toEqual(["a.ts:7"]);
    expect(found.testsWithoutAssertions).toEqual(['a.test.ts: "forgets"']);
  });
});

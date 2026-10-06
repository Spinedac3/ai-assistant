import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { ROOT, type SourceFile, sourceFiles } from "./support/source.js";

// camelCase modules and PascalCase components, with qualifiers as in a.test.ts or a.golden.test.ts
const FILE_NAME = /^[A-Za-z][A-Za-z0-9]*(\.[a-z]+)*\.tsx?$/;
const TOOL_NAME = /^[a-z]+(_[a-z]+)*$/;
// The project is generic: no trace of where it came from. Kept as hashes so naming it here does
// not leave the trace this check looks for
const ORIGIN = new Set([
  "d1c7c99c6e2e7b311f51dd9d19161a5832625fb21f35131fba6da62513f0c099",
  "b5aa80fcc17130484d8e07a96fdb3f910442510f1f677de8aae0aeb069ca8489",
  "49cadf162d244d8ba78f8e2e1f7f302921fca7fbda7b46c2440136fcb4b8f02b",
]);
// What is not ours to name, or is not text
const SKIPPED = new Set(["node_modules", "dist", ".git", "secrets", "pnpm-lock.yaml"]);
const BINARY = /\.(png|jpe?g|gif|ico|woff2?|ttf|xlsx|pdf|zip)$/i;

interface NamingVerdict {
  fileNames: string[];
  identifiers: string[];
  tools: string[];
  origin: string[];
}

/**
 * Reads every text file of the repository, besides dependencies, builds and secrets
 *
 * @return  Each file with its path relative to the repository
 */
function repositoryFiles(): SourceFile[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      // A local .env may hold anything; the example that is committed is checked like the rest
      if (SKIPPED.has(name) || (name.startsWith(".env") && name !== ".env.example")) {
        return [];
      }
      if (statSync(path).isDirectory()) {
        return walk(path);
      }
      return BINARY.test(name) ? [] : [path];
    });

  return walk(ROOT).map((path) => ({
    path: relative(ROOT, path).split(sep).join("/"),
    text: readFileSync(path, "utf8"),
  }));
}

/**
 * Checks the names of some files: a pure function, so the cases below can feed it
 *
 * @param   code    TypeScript files
 * @param   all     Every text file of the repository
 * @param   origin  Hashes of the words that must not appear
 *
 * @return  The names breaking each rule
 */
function namingVerdict(
  code: SourceFile[],
  all: SourceFile[],
  origin: ReadonlySet<string> = ORIGIN,
): NamingVerdict {
  const verdict: NamingVerdict = { fileNames: [], identifiers: [], tools: [], origin: [] };
  for (const file of code) {
    if (!FILE_NAME.test(file.path.split("/").pop() ?? "")) {
      verdict.fileNames.push(file.path);
    }
    const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: the range is what ASCII is
      if (ts.isIdentifier(node) && /[^\x00-\x7F]/.test(node.text)) {
        verdict.identifiers.push(`${file.path}: ${node.text}`);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    if (file.path.includes("tools/native/")) {
      const names = [...file.text.matchAll(/^\s+name: (?:"([^"]+)"|([A-Z_]+)),/gm)].map(
        ([, literal, constant]) =>
          literal ?? new RegExp(`const ${constant} = "([^"]+)"`).exec(file.text)?.[1] ?? "",
      );
      // A tool whose name this cannot read would pass unchecked
      if (names.length === 0) {
        verdict.tools.push(`${file.path}: sin nombre legible`);
      }
      for (const name of names.filter((name) => !TOOL_NAME.test(name))) {
        verdict.tools.push(`${file.path}: ${name}`);
      }
    }
  }
  for (const file of all) {
    // Whole words and each piece of a camelCase name, so a name glued into an identifier shows
    const words = new Set(
      (file.text.match(/[A-Za-z]+/g) ?? []).flatMap((word) => [
        word.toLowerCase(),
        ...(word.match(/[A-Z]+(?![a-z])|[A-Z]?[a-z]+/g) ?? []).map((piece) => piece.toLowerCase()),
      ]),
    );
    if ([...words].some((word) => origin.has(createHash("sha256").update(word).digest("hex")))) {
      verdict.origin.push(file.path);
    }
  }

  return verdict;
}

describe("naming", () => {
  const found = namingVerdict(
    [
      ...sourceFiles("src"),
      ...sourceFiles("tests"),
      ...sourceFiles("web/src"),
      ...sourceFiles("web/src", ".tsx"),
    ],
    repositoryFiles(),
  );

  it("names files in camelCase, and components in PascalCase", () => {
    // Performs assertions.
    expect(found.fileNames).toEqual([]);
  });

  it("writes identifiers in plain English letters", () => {
    // Performs assertions.
    expect(found.identifiers).toEqual([]);
  });

  it("names native tools in snake_case", () => {
    // Performs assertions.
    expect(found.tools).toEqual([]);
  });

  it("leaves no trace of the project it came from", () => {
    // Performs assertions.
    expect(found.origin).toEqual([]);
  });
});

describe("naming, fed a breach of each rule", () => {
  it("names each breach and lets healthy names through", () => {
    // Performs the test.
    const found = namingVerdict(
      [
        { path: "src/rag/convert.ts", text: "const pages = 1;\n" },
        { path: "web/src/docs/DocsPage.tsx", text: "export const x = 1;\n" },
        { path: "tests/golden/rag.golden.test.ts", text: "" },
        { path: "src/rag/pdf_convert.ts", text: "" },
        { path: "src/rag/año.ts", text: "const año = 1;\n" },
        { path: "src/tools/native/bad.ts", text: '    name: "readPdf",\n    name: "read_pdf",\n' },
        {
          path: "src/tools/native/constant.ts",
          text: 'export const SEND = "sendNotice";\n      name: SEND,\n',
        },
        { path: "src/tools/native/hidden.ts", text: "      name: names.next(),\n" },
      ],
      [
        { path: "README.md", text: "Un asistente genérico" },
        { path: "docs/origin.md", text: "Antes se llamaba ACME." },
        { path: "src/legacy.ts", text: "const acmeClient = connect();" },
        { path: "src/shouting.ts", text: "const client = new ACMEClient();" },
      ],
      new Set(["822b33ad87c148a0a20a5ba7cd5ebcaa68d36a18e7aad165554903f52ca82757"]),
    );

    // Performs assertions.
    expect(found.fileNames).toEqual(["src/rag/pdf_convert.ts", "src/rag/año.ts"]);
    expect(found.identifiers).toEqual(["src/rag/año.ts: año"]);
    expect(found.tools).toEqual([
      "src/tools/native/bad.ts: readPdf",
      "src/tools/native/constant.ts: sendNotice",
      "src/tools/native/hidden.ts: sin nombre legible",
    ]);
    expect(found.origin).toEqual(["docs/origin.md", "src/legacy.ts", "src/shouting.ts"]);
  });
});

import ts from "typescript";
import { describe, expect, it } from "vitest";
import { type SourceFile, sourceFiles } from "./support/source.js";

// Folders that only build on the language and their packages
const LEAVES = ["lib", "config", "vault"];
// What composes the application: nothing below it may lean on it
const COMPOSITION = ["routes", "plugins", "app", "index"];
// Drivers of the databases a person registers, and of our own
const DATABASE_DRIVER = /^(mssql|mysql2(\/.*)?|pg)$/;
const SUBPROCESS = /^(node:)?child_process$/;

interface Violations {
  leavesLean: string[];
  dbImportsCode: string[];
  composedFromBelow: string[];
  permissionsServe: string[];
  sourcesLean: string[];
  driversLoose: string[];
  subprocessLoose: string[];
}

/**
 * Names the folder a path under src/ belongs to; a file at the top is its own folder
 *
 * @param   path  Path relative to src/
 *
 * @return  The folder
 */
function folderOf(path: string): string {
  return path.includes("/") ? (path.split("/")[0] ?? "") : path.replace(/\.(ts|js)$/, "");
}

/**
 * Lists every module a file reaches: imports, re-exports, `import()` and `require`
 *
 * @param   file   File, with its path relative to src/
 * @param   types  Whether a reach for types alone counts
 *
 * @return  The module specifiers as written
 */
function modulesOf(file: SourceFile, types = true): string[] {
  const source = ts.createSourceFile(file.path, file.text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    let specifier: ts.Expression | undefined;
    let typeOnly = false;
    if (ts.isImportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      const clause = node.importClause;
      const named = clause?.namedBindings;
      typeOnly =
        clause?.isTypeOnly === true ||
        (clause?.name === undefined &&
          named !== undefined &&
          ts.isNamedImports(named) &&
          named.elements.length > 0 &&
          named.elements.every((element) => element.isTypeOnly));
    } else if (ts.isExportDeclaration(node)) {
      specifier = node.moduleSpecifier;
      typeOnly = node.isTypeOnly;
    } else if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require"))
    ) {
      specifier = node.arguments[0];
    }
    if (specifier && ts.isStringLiteralLike(specifier) && (types || !typeOnly)) {
      found.push(specifier.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return found;
}

/**
 * Lists the folders a file imports from, besides its own
 *
 * @param   file   File, with its path relative to src/
 * @param   types  Whether a reach for types alone counts
 *
 * @return  The folders
 */
function importsOf(file: SourceFile, types = true): string[] {
  const own = folderOf(file.path);
  const depth = file.path.split("/").length - 1;
  const found = new Set<string>();
  for (const specifier of modulesOf(file, types).filter((module) => module.startsWith("."))) {
    const parts = [...file.path.split("/").slice(0, depth)];
    for (const step of specifier.split("/")) {
      if (step === "..") {
        parts.pop();
      } else if (step !== ".") {
        parts.push(step);
      }
    }
    const target = folderOf(parts.join("/"));
    if (target !== own) {
      found.add(target);
    }
  }

  return [...found];
}

/**
 * Checks who imports whom: a pure function of the sources, so the mutants below can feed it
 *
 * @param   files  Files with their path relative to src/
 *
 * @return  The files breaking each rule
 */
function layerViolations(files: SourceFile[]): Violations {
  const where = (path: string, folders: string[]) => folders.includes(folderOf(path));
  const breaking = (rule: (file: SourceFile) => boolean) =>
    files.filter(rule).map((file) => file.path);

  return {
    leavesLean: breaking((file) => where(file.path, LEAVES) && importsOf(file).length > 0),
    dbImportsCode: breaking(
      (file) => where(file.path, ["db"]) && importsOf(file, false).length > 0,
    ),
    composedFromBelow: breaking(
      (file) =>
        !where(file.path, COMPOSITION) &&
        importsOf(file).some((folder) => COMPOSITION.includes(folder)),
    ),
    permissionsServe: breaking(
      (file) =>
        where(file.path, ["permissions"]) &&
        importsOf(file).some((folder) => !["db", "lib", "config"].includes(folder)),
    ),
    sourcesLean: breaking(
      (file) =>
        where(file.path, ["sources"]) &&
        importsOf(file).some((folder) => !["db", "vault", "lib", "config"].includes(folder)),
    ),
    driversLoose: breaking(
      (file) =>
        !where(file.path, ["sources", "db", "cli"]) &&
        modulesOf(file).some((module) => DATABASE_DRIVER.test(module)),
    ),
    subprocessLoose: breaking(
      (file) =>
        !where(file.path, ["llm", "index"]) &&
        modulesOf(file).some((module) => SUBPROCESS.test(module)),
    ),
  };
}

describe("layers", () => {
  const files = sourceFiles("src").map((file) => ({
    path: file.path.replace(/^src\//, ""),
    text: file.text,
  }));
  const found = layerViolations(files);

  it("keeps lib/, config/ and vault/ free of the rest of the application, and of each other", () => {
    // Performs assertions.
    expect(found.leavesLean).toEqual([]);
  });

  it("lets db/ borrow only types, to describe its json columns", () => {
    // Performs assertions.
    expect(found.dbImportsCode).toEqual([]);
  });

  it("composes routes, plugins and the app from above: nothing below imports them", () => {
    // Performs assertions.
    expect(found.composedFromBelow).toEqual([]);
  });

  it("keeps permissions/ deciding, never serving: it imports no chat, route or tool", () => {
    // Performs assertions.
    expect(found.permissionsServe).toEqual([]);
  });

  it("keeps sources/ on the database, the vault and the helpers alone", () => {
    // Performs assertions.
    expect(found.sourcesLean).toEqual([]);
  });

  it("speaks to a database driver only from sources/, db/ and the console", () => {
    // Performs assertions.
    expect(found.driversLoose).toEqual([]);
  });

  it("starts a subprocess only from llm/ and the composition root", () => {
    // Performs assertions.
    expect(found.subprocessLoose).toEqual([]);
  });
});

describe("layers, fed a breach of each rule", () => {
  const healthy: SourceFile[] = [
    { path: "lib/pdf.ts", text: 'import { PDFDocument } from "pdf-lib";\n' },
    { path: "db/schema.ts", text: 'import type { TraceEntry } from "../chat/trace.js";\n' },
    {
      path: "sources/engines.ts",
      text: 'import mssql from "mssql";\nimport { x } from "../vault/envelope.js";\n',
    },
    { path: "llm/cli.ts", text: 'import { spawn } from "node:child_process";\n' },
    { path: "routes/docs.ts", text: 'import { PdfConverter } from "../rag/convert.js";\n' },
    { path: "app.ts", text: 'import { docsRoutes } from "./routes/docs.js";\n' },
  ];
  const withOne = (file: SourceFile) => layerViolations([...healthy, file]);

  it("finds nothing in healthy code", () => {
    // Performs the test.
    const found = layerViolations(healthy);

    // Performs assertions.
    expect(Object.values(found).flat()).toEqual([]);
  });

  it("names each breach", () => {
    // Performs the test.
    const found = {
      leaf: withOne({ path: "lib/bad.ts", text: 'import { db } from "../db/client.js";\n' }),
      db: withOne({ path: "db/bad.ts", text: 'import { chatTurn } from "../chat/turn.js";\n' }),
      below: withOne({
        path: "rag/bad.ts",
        text: 'import { docsRoutes } from "../routes/docs.js";\n',
      }),
      permissions: withOne({
        path: "permissions/bad.ts",
        text: 'import { x } from "../chat/turn.js";\n',
      }),
      sources: withOne({
        path: "sources/bad.ts",
        text: 'import { x } from "../tools/registry.js";\n',
      }),
      driver: withOne({ path: "tools/bad.ts", text: 'import mysql from "mysql2/promise";\n' }),
      subprocess: withOne({ path: "rag/bad.ts", text: 'import { exec } from "child_process";\n' }),
    };

    // Performs assertions.
    expect(found.leaf.leavesLean).toEqual(["lib/bad.ts"]);
    expect(found.db.dbImportsCode).toEqual(["db/bad.ts"]);
    expect(found.below.composedFromBelow).toEqual(["rag/bad.ts"]);
    expect(found.permissions.permissionsServe).toEqual(["permissions/bad.ts"]);
    expect(found.sources.sourcesLean).toEqual(["sources/bad.ts"]);
    expect(found.driver.driversLoose).toEqual(["tools/bad.ts"]);
    expect(found.subprocess.subprocessLoose).toEqual(["rag/bad.ts"]);
  });

  it("sees a module reached by re-export, bare import, import() or require", () => {
    // Performs the test.
    const found = {
      reexport: withOne({ path: "lib/bad.ts", text: 'export { x } from "../chat/turn.js";\n' }),
      bare: withOne({ path: "rag/bad.ts", text: 'import "../routes/docs.js";\n' }),
      dynamic: withOne({ path: "tools/bad.ts", text: 'const pg = await import("pg");\n' }),
      required: withOne({
        path: "rag/bad.ts",
        text: 'const cp = require("node:child_process");\n',
      }),
      typeExport: withOne({
        path: "db/bad.ts",
        text: 'export type { X } from "../chat/trace.js";\n',
      }),
      inlineTypes: withOne({
        path: "db/bad.ts",
        text: 'import { type X, type Y } from "../chat/trace.js";\n',
      }),
    };

    // Performs assertions.
    expect(found.reexport.leavesLean).toEqual(["lib/bad.ts"]);
    expect(found.bare.composedFromBelow).toEqual(["rag/bad.ts"]);
    expect(found.dynamic.driversLoose).toEqual(["tools/bad.ts"]);
    expect(found.required.subprocessLoose).toEqual(["rag/bad.ts"]);
    expect(found.typeExport.dbImportsCode).toEqual([]);
    expect(found.inlineTypes.dbImportsCode).toEqual([]);
  });
});

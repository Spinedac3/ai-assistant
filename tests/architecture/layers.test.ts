import { describe, expect, it } from "vitest";
import { type SourceFile, sourceFiles } from "./support/source.js";

// Folders that only build on the language and their packages
const LEAVES = ["lib", "config", "vault"];
// What composes the application: nothing below it may lean on it
const COMPOSITION = ["routes", "plugins", "app", "index"];
// Drivers of the databases a person registers, and of our own
const DATABASE_DRIVER = /from "(mssql|mysql2(\/[^"]*)?|pg)"/;
const SUBPROCESS = /from "(node:)?child_process"/;

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
 * Lists the folders a file imports from, besides its own
 *
 * @param   file       File, with its path relative to src/
 * @param   typesOnly  Whether `import type` counts
 *
 * @return  The folders
 */
function importsOf(file: SourceFile, typesOnly = true): string[] {
  const own = folderOf(file.path);
  const depth = file.path.split("/").length - 1;
  const found = new Set<string>();
  for (const match of file.text.matchAll(/^import (type )?[^;]*?from "(\.[^"]+)"/gm)) {
    if (!typesOnly && match[1]) {
      continue;
    }
    const parts = [...file.path.split("/").slice(0, depth)];
    for (const step of (match[2] ?? "").split("/")) {
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
      (file) => !where(file.path, ["sources", "db", "cli"]) && DATABASE_DRIVER.test(file.text),
    ),
    subprocessLoose: breaking(
      (file) => !where(file.path, ["llm", "index"]) && SUBPROCESS.test(file.text),
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
});

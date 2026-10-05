import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRagEnv } from "../config/env.js";
import { areaScope, parseDocument } from "../rag/document.js";
import { ingestDocument } from "../rag/ingest.js";
import { indexFrom, storageFrom } from "../rag/services.js";

// Indexes every .md of a folder right away, without the queue, so it works with the server stopped.
// Unlike the upload route it does not check that each area exists as a permission, and it does not
// wait for the server worker: run it when nothing else is indexing
const folder = process.argv[2];
if (!folder) {
  throw new Error("Uso: pnpm docs:load <carpeta con archivos .md>");
}

const env = loadRagEnv();
const index = indexFrom(env);
const storage = storageFrom(env);
await storage.ensureBucket();

let failed = 0;
for (const name of readdirSync(folder)
  .filter((file) => file.endsWith(".md"))
  .sort()) {
  const raw = readFileSync(join(folder, name), "utf8");
  try {
    const document = parseDocument(raw);
    const { doc_code: code, area } = document.frontmatter;
    await storage.save(code, "md", Buffer.from(raw, "utf8"), areaScope(area));
    const result = await ingestDocument(index, document);
    const moved =
      result.superseded.length > 0 ? `, reemplaza a ${result.superseded.join(", ")}` : "";
    console.info(`${name}: ${result.chunks} pedazos${moved}`);
  } catch (error) {
    failed++;
    console.error(`${name}: ${(error as Error).message}`);
  }
}

process.exitCode = failed > 0 ? 1 : 0;

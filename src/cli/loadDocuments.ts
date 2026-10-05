import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadRagEnv } from "../config/env.js";
import { parseDocument } from "../rag/document.js";
import { Embedder } from "../rag/embeddings.js";
import { ingestDocument } from "../rag/ingest.js";
import { Solr } from "../rag/solr.js";
import { DocumentStorage } from "../rag/storage.js";

// Indexes every .md of a folder right away, without the queue, so it works with the server stopped
const folder = process.argv[2];
if (!folder) {
  throw new Error("Uso: pnpm docs:load <carpeta con archivos .md>");
}

const env = loadRagEnv();
const index = {
  solr: new Solr(env.SOLR_URL),
  embedder: new Embedder(env.EMBED_URL),
  cores: { current: "docs", historical: "docs_historical" },
};
const storage = new DocumentStorage({
  endpoint: env.S3_ENDPOINT,
  accessKey: env.S3_ACCESS_KEY,
  secretKey: env.S3_SECRET_KEY,
  bucket: env.S3_BUCKET,
});
await storage.ensureBucket();

let failed = 0;
for (const name of readdirSync(folder)
  .filter((file) => file.endsWith(".md"))
  .sort()) {
  const raw = readFileSync(join(folder, name), "utf8");
  try {
    const document = parseDocument(raw);
    await storage.save(document.frontmatter.doc_code, "md", Buffer.from(raw, "utf8"));
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

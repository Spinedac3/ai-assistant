import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { loadExternalSystems } from "./auth/externalSystems.js";
import { createTokenSigner, readPrivateKey } from "./auth/tokens.js";
import { chatMcpConfig } from "./chat/mcpConfig.js";
import { readOrganizationContext } from "./chat/prompt.js";
import { loadEnv } from "./config/env.js";
import { connectDatabase } from "./db/client.js";
import { DEFAULT_ACCESS_CONTACT } from "./mcp/capabilities.js";
import { purgeIntents } from "./mcp/intents.js";
import { CapabilityRanker } from "./mcp/ranking.js";
import { Embedder } from "./rag/embeddings.js";
import type { Index } from "./rag/ingest.js";
import { startWorker } from "./rag/jobs.js";
import { Solr } from "./rag/solr.js";
import { DocumentStorage } from "./rag/storage.js";
import { readSetting } from "./settings.js";
import { calculateTool } from "./tools/native/calculate.js";
import { fetchTool, searchTool } from "./tools/native/documents.js";
import { ToolRegistry } from "./tools/registry.js";

const env = loadEnv();
const database = connectDatabase(env.DATABASE_URL);
const organizationContext = readOrganizationContext(env.ASSISTANT_CONTEXT_FILE);
const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, "");

const embedder = new Embedder(env.EMBED_URL);
const index: Index = {
  solr: new Solr(env.SOLR_URL),
  embedder,
  cores: { current: "docs", historical: "docs_historical" },
};
const storage = new DocumentStorage({
  endpoint: env.S3_ENDPOINT,
  accessKey: env.S3_ACCESS_KEY,
  secretKey: env.S3_SECRET_KEY,
  bucket: env.S3_BUCKET,
});

const registry = new ToolRegistry(database.db);
registry.register(calculateTool);
registry.register(searchTool(index));
registry.register(fetchTool(index));

const app = await buildApp({
  db: database.db,
  signer: createTokenSigner(
    readPrivateKey(env.JWT_PRIVATE_KEY_FILE),
    env.JWT_ISSUER,
    env.JWT_TTL_SECONDS,
  ),
  systems: loadExternalSystems(env.EXTERNAL_SYSTEMS_FILE),
  chat: {
    cli: { bin: env.CLAUDE_BIN },
    model: env.CHAT_MODEL,
    // One directory per conversation: it is what lets --continue resume the thread
    workspacesDir: env.CHAT_WORKSPACES_DIR ?? join(tmpdir(), "ai-assistant-chat"),
    prompt: {
      assistantName: env.ASSISTANT_NAME,
      timeZone: env.APP_TIMEZONE,
      organizationContext,
    },
    limits: {
      msgsPerHour: env.RATE_LIMIT_MSGS_PER_HOUR,
      msgsPerDay: env.RATE_LIMIT_MSGS_PER_DAY,
      tokensPerDay: env.RATE_LIMIT_TOKENS_PER_DAY,
    },
    // The CLI runs on this host, so it reaches /mcp locally rather than through the public address
    mcpConfig: chatMcpConfig(database.db, `http://127.0.0.1:${env.PORT}/mcp`),
  },
  mcp: {
    registry,
    publicBaseUrl,
    settings: {
      assistantName: env.ASSISTANT_NAME,
      organizationContext,
      timeZone: env.APP_TIMEZONE,
      accessContact: async () =>
        (await readSetting(database.db, "access.contact")) ?? DEFAULT_ACCESS_CONTACT,
      ranker: new CapabilityRanker(embedder),
    },
  },
  docs: { index, storage },
  logger: true,
  trustProxy: env.TRUST_PROXY,
});

// Tool failures, broken contracts and audit errors must reach the server log
registry.useLogger(app.log);

// Questions from external clients are kept only for the retention period
const purge = () =>
  purgeIntents(database.db, env.MCP_INTENT_RETENTION_DAYS).catch((error) =>
    app.log.error({ err: error }, "intent purge failed"),
  );
void purge();
const purgeTimer = setInterval(purge, 6 * 3_600_000);
purgeTimer.unref();

// Without the bucket every upload would fail; the server still starts so search keeps working
await storage
  .ensureBucket()
  .catch((error) => app.log.error({ err: error }, "document storage unavailable"));
const stopWorker = env.DOCS_WORKER_ENABLED
  ? startWorker({
      db: database.db,
      storage,
      index,
      logger: app.log,
      pollMs: env.DOCS_WORKER_POLL_MS,
    })
  : () => {};

app.addHook("onClose", async () => {
  clearInterval(purgeTimer);
  stopWorker();
  await database.close();
});

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

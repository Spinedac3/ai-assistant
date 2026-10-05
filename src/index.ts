import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { loadExternalSystems } from "./auth/externalSystems.js";
import { createTokenSigner, readPrivateKey } from "./auth/tokens.js";
import { chatMcpConfig } from "./chat/mcpConfig.js";
import { readOrganizationContext } from "./chat/prompt.js";
import { loadEnv } from "./config/env.js";
import { connectDatabase } from "./db/client.js";
import { ExportStore } from "./exports/store.js";
import { DEFAULT_ACCESS_CONTACT } from "./mcp/capabilities.js";
import { purgeIntents } from "./mcp/intents.js";
import { CapabilityRanker } from "./mcp/ranking.js";
import { startWorker } from "./rag/jobs.js";
import { indexFrom, storageFrom } from "./rag/services.js";
import { Secrets } from "./vault/envelope.js";
import { readSetting } from "./settings.js";
import { calculateTool } from "./tools/native/calculate.js";
import { fetchTool, searchTool } from "./tools/native/documents.js";
import { ToolRegistry } from "./tools/registry.js";

const env = loadEnv();
const database = connectDatabase(env.DATABASE_URL);
const organizationContext = readOrganizationContext(env.ASSISTANT_CONTEXT_FILE);
const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, "");

const secrets = Secrets.fromFile(env.SECRETS_KEK_FILE);
const index = indexFrom(env);
const exports = new ExportStore(
  database.db,
  {
    endpoint: env.S3_ENDPOINT,
    accessKey: env.S3_ACCESS_KEY,
    secretKey: env.S3_SECRET_KEY,
    bucket: env.S3_BUCKET,
  },
  secrets.derive("export-links"),
  publicBaseUrl,
);
const storage = storageFrom(env);

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
      ranker: new CapabilityRanker(index.embedder),
    },
  },
  docs: { index, storage },
  sources: { secrets },
  exports: { exports },
  logger: true,
  trustProxy: env.TRUST_PROXY,
});

// Tool failures, broken contracts and audit errors must reach the server log
registry.useLogger(app.log);
registry.useExports(exports);

// Questions from external clients are kept only for the retention period
const purge = () =>
  purgeIntents(database.db, env.MCP_INTENT_RETENTION_DAYS).catch((error) =>
    app.log.error({ err: error }, "intent purge failed"),
  );
void purge();
const purgeTimer = setInterval(purge, 6 * 3_600_000);

// Exported files live seven days; an hourly sweep keeps them from outliving that by much
const purgeExports = () =>
  exports.purge().catch((error) => app.log.error({ err: error }, "export purge failed"));
const exportsTimer = setInterval(purgeExports, 3_600_000);
exportsTimer.unref();
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
  : async () => {};

app.addHook("onClose", async () => {
  clearInterval(purgeTimer);
  clearInterval(exportsTimer);
  await stopWorker();
  await database.close();
});

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

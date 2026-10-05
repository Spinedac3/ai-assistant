import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { loadExternalSystems } from "./auth/externalSystems.js";
import { createTokenSigner, readPrivateKey } from "./auth/tokens.js";
import { chatMcpConfig } from "./chat/mcpConfig.js";
import { readOrganizationContext } from "./chat/prompt.js";
import { loadEnv } from "./config/env.js";
import { CreatedTools } from "./creator/store.js";
import { connectDatabase } from "./db/client.js";
import { ExportStore } from "./exports/store.js";
import { askOnce } from "./llm/oneShot.js";
import { DEFAULT_ACCESS_CONTACT } from "./mcp/capabilities.js";
import { purgeIntents } from "./mcp/intents.js";
import { CapabilityRanker } from "./mcp/ranking.js";
import { smtpMailer } from "./notices/mailer.js";
import { purgeNotices, startNoticeWorker } from "./notices/outbox.js";
import { startWorker } from "./rag/jobs.js";
import { indexFrom, s3Config, storageFrom } from "./rag/services.js";
import { readSetting } from "./settings.js";
import { calculateTool } from "./tools/native/calculate.js";
import { fetchTool, searchTool } from "./tools/native/documents.js";
import { ingestTool } from "./tools/native/ingest.js";
import { sendNoticeTool } from "./tools/native/sendNotice.js";
import { ToolRegistry } from "./tools/registry.js";
import { Secrets } from "./vault/envelope.js";

const env = loadEnv();
const database = connectDatabase(env.DATABASE_URL);
const organizationContext = readOrganizationContext(env.ASSISTANT_CONTEXT_FILE);
const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${env.PORT}`).replace(/\/+$/, "");

const secrets = Secrets.fromFile(env.SECRETS_KEK_FILE);
const index = indexFrom(env);
const exports = new ExportStore(
  database.db,
  s3Config(env),
  secrets.derive("export-links"),
  publicBaseUrl,
);
const storage = storageFrom(env);

const registry = new ToolRegistry(database.db);
registry.register(calculateTool);
registry.register(searchTool(index));
registry.register(fetchTool(index));
registry.register(ingestTool({ db: database.db, index, storage }));
// Without a mail server there is nowhere to deliver; queuing notices nobody gets would only hide it
const mailer = env.SMTP_HOST
  ? smtpMailer({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      from: env.SMTP_FROM ?? "",
      user: env.SMTP_USER,
      passwordFile: env.SMTP_PASSWORD_FILE,
      insecure: env.SMTP_INSECURE,
    })
  : null;
if (mailer) {
  registry.register(sendNoticeTool(database.db));
}
const createdTools = new CreatedTools(registry, {
  db: database.db,
  secrets,
  appTimeZone: env.APP_TIMEZONE,
});

// The chat's settings, shared by the trial chat of the creator
const chat = {
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
};
// The CLI runs on this host, so it reaches /mcp locally rather than through the public address
const mcpUrl = `http://127.0.0.1:${env.PORT}/mcp`;

const app = await buildApp({
  db: database.db,
  signer: createTokenSigner(
    readPrivateKey(env.JWT_PRIVATE_KEY_FILE),
    env.JWT_ISSUER,
    env.JWT_TTL_SECONDS,
  ),
  systems: loadExternalSystems(env.EXTERNAL_SYSTEMS_FILE),
  passwordReset: { mailer, publicBaseUrl, assistantName: env.ASSISTANT_NAME },
  usage: { timeZone: env.APP_TIMEZONE },
  chat: {
    ...chat,
    mcpConfig: chatMcpConfig(database.db, mcpUrl),
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
  sources: { secrets, onSaved: (code, retargeted) => createdTools.sourceChanged(code, retargeted) },
  tools: {
    secrets,
    appTimeZone: env.APP_TIMEZONE,
    created: createdTools,
    trial: { chat, mcpUrl, registry },
    // The guide answers with the chat's model, read on each call as the chat reads it
    ask: async (prompt) =>
      askOnce(
        {
          cli: chat.cli,
          model: (await readSetting(database.db, "chat.model")) ?? env.CHAT_MODEL,
          workspacesDir: chat.workspacesDir,
        },
        prompt,
      ),
  },
  exports: { exports },
  logger: true,
  trustProxy: env.TRUST_PROXY,
});

// Tool failures, broken contracts and audit errors must reach the server log
registry.useLogger(app.log);
registry.useExports(exports);

// Tools made in the creator join the registry as stored, without waiting on their sources
createdTools.useLogger(app.log);
await createdTools
  .load()
  .catch((error) => app.log.error({ err: error }, "created tools could not load"));

// Questions from external clients are kept only for the retention period, notices a month
const purge = () =>
  Promise.all([
    purgeIntents(database.db, env.MCP_INTENT_RETENTION_DAYS).catch((error) =>
      app.log.error({ err: error }, "intent purge failed"),
    ),
    // Old notices carry their text; spent reset links are of no use
    purgeNotices(database.db).catch((error) =>
      app.log.error({ err: error }, "notice purge failed"),
    ),
  ]);
void purge();
const purgeTimer = setInterval(purge, 6 * 3_600_000);
purgeTimer.unref();

// Exported files live seven days; an hourly sweep keeps them from outliving that by much. The same
// sweep drops the parts of documents left unfinished; a day, well past the hour an upload takes,
// so a server clock off from the storage clock never drops parts in use
const purgeExports = () =>
  Promise.all([
    exports.purge().catch((error) => app.log.error({ err: error }, "export purge failed")),
    storage
      .purgeParts(new Date(Date.now() - 86_400_000))
      .catch((error) => app.log.error({ err: error }, "document part purge failed")),
  ]);
void purgeExports();
const exportsTimer = setInterval(purgeExports, 3_600_000);
exportsTimer.unref();

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

const stopNotices = mailer
  ? startNoticeWorker({
      db: database.db,
      send: mailer,
      assistantName: env.ASSISTANT_NAME,
      logger: app.log,
      pollMs: env.NOTICES_WORKER_POLL_MS,
    })
  : async () => {};

app.addHook("onClose", async () => {
  clearInterval(purgeTimer);
  clearInterval(exportsTimer);
  await stopWorker();
  await stopNotices();
  await database.close();
});

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

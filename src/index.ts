import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "./app.js";
import { loadExternalSystems } from "./auth/externalSystems.js";
import { createTokenSigner, readPrivateKey } from "./auth/tokens.js";
import { readOrganizationContext } from "./chat/prompt.js";
import { loadEnv } from "./config/env.js";
import { connectDatabase } from "./db/client.js";

const env = loadEnv();
const database = connectDatabase(env.DATABASE_URL);

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
      organizationContext: readOrganizationContext(env.ASSISTANT_CONTEXT_FILE),
    },
    limits: {
      msgsPerHour: env.RATE_LIMIT_MSGS_PER_HOUR,
      msgsPerDay: env.RATE_LIMIT_MSGS_PER_DAY,
      tokensPerDay: env.RATE_LIMIT_TOKENS_PER_DAY,
    },
  },
  logger: true,
});

app.addHook("onClose", () => database.close());

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

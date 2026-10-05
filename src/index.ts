import { buildApp } from "./app.js";
import { loadExternalSystems } from "./auth/externalSystems.js";
import { createTokenSigner, readPrivateKey } from "./auth/tokens.js";
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
  logger: true,
});

app.addHook("onClose", () => database.close());

try {
  await app.listen({ port: env.PORT, host: "0.0.0.0" });
} catch (error) {
  app.log.error(error);
  process.exit(1);
}

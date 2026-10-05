import Fastify, { type FastifyInstance } from "fastify";
import type { ExternalSystem } from "./auth/externalSystems.js";
import type { TokenSigner } from "./auth/tokens.js";
import type { Database } from "./db/client.js";
import authPlugin from "./plugins/auth.js";
import authRoutes from "./routes/auth.js";
import chatRoutes, { type ChatRoutesOptions } from "./routes/chat.js";

export interface AppDependencies {
  db: Database;
  signer: TokenSigner;
  systems: Map<string, ExternalSystem>;
  // Without it the chat routes are not mounted, which keeps auth-only tests light
  chat?: Omit<ChatRoutesOptions, "db">;
  logger?: boolean;
}

/**
 * Builds the HTTP application without binding a port
 *
 * @param   deps  Database, token signer, external systems and chat settings
 *
 * @return  The configured Fastify instance
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: true });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(authPlugin, { db: deps.db, signer: deps.signer });
  await app.register(authRoutes, { db: deps.db, signer: deps.signer, systems: deps.systems });

  if (deps.chat) {
    await app.register(chatRoutes, { ...deps.chat, db: deps.db });
  }

  return app;
}

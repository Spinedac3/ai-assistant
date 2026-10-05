import Fastify, { type FastifyInstance } from "fastify";
import type { ExternalSystem } from "./auth/externalSystems.js";
import type { TokenSigner } from "./auth/tokens.js";
import type { Database } from "./db/client.js";
import type { McpSettings } from "./mcp/server.js";
import authPlugin from "./plugins/auth.js";
import adminRoutes from "./routes/admin.js";
import authRoutes from "./routes/auth.js";
import chatRoutes, { type ChatRoutesOptions } from "./routes/chat.js";
import docsRoutes, { type DocsRoutesOptions } from "./routes/docs.js";
import exportsRoutes, { type ExportsRoutesOptions } from "./routes/exports.js";
import mcpRoutes from "./routes/mcp.js";
import oauthRoutes from "./routes/oauth.js";
import passwordResetRoutes, { type PasswordResetRoutesOptions } from "./routes/passwordReset.js";
import sourcesRoutes, { type SourcesRoutesOptions } from "./routes/sources.js";
import toolsRoutes, { type ToolsRoutesOptions } from "./routes/tools.js";
import usageRoutes, { type UsageRoutesOptions } from "./routes/usage.js";
import type { ToolRegistry } from "./tools/registry.js";

export interface AppDependencies {
  db: Database;
  signer: TokenSigner;
  systems: Map<string, ExternalSystem>;
  // Without it the chat routes are not mounted, which keeps auth-only tests light
  chat?: Omit<ChatRoutesOptions, "db">;
  // Without it /mcp and the OAuth server that guards it are not mounted
  mcp?: { registry: ToolRegistry; settings: McpSettings; publicBaseUrl: string };
  // Without it exported files cannot be downloaded
  exports?: ExportsRoutesOptions;
  // Without it the source administration is not mounted
  sources?: Omit<SourcesRoutesOptions, "db">;
  // The creator of tools over the registered sources
  tools?: Omit<ToolsRoutesOptions, "db">;
  // Without it the document routes are not mounted
  docs?: Omit<DocsRoutesOptions, "db">;
  // Without it there is no usage report
  usage?: Omit<UsageRoutesOptions, "db">;
  // Without it a password cannot be reset by mail
  passwordReset?: Omit<PasswordResetRoutesOptions, "db">;
  logger?: boolean;
  // Addresses or CIDRs of the proxies whose X-Forwarded-For is believed; none by default
  trustProxy?: string;
}

/**
 * Builds the HTTP application without binding a port
 *
 * @param   deps  Database, token signer, external systems, chat and MCP settings
 *
 * @return  The configured Fastify instance
 */
export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: deps.logger ?? false, trustProxy: deps.trustProxy ?? false });

  app.get("/health", async () => ({ status: "ok" }));

  await app.register(authPlugin, { db: deps.db, signer: deps.signer });
  await app.register(authRoutes, { db: deps.db, signer: deps.signer, systems: deps.systems });
  await app.register(adminRoutes, { db: deps.db });
  if (deps.usage) {
    await app.register(usageRoutes, { ...deps.usage, db: deps.db });
  }
  if (deps.passwordReset) {
    await app.register(passwordResetRoutes, { ...deps.passwordReset, db: deps.db });
  }

  if (deps.chat) {
    await app.register(chatRoutes, { ...deps.chat, db: deps.db });
  }

  if (deps.exports) {
    await app.register(exportsRoutes, deps.exports);
  }

  if (deps.sources) {
    await app.register(sourcesRoutes, { ...deps.sources, db: deps.db });
  }

  if (deps.tools) {
    await app.register(toolsRoutes, { ...deps.tools, db: deps.db });
  }

  if (deps.docs) {
    await app.register(docsRoutes, { ...deps.docs, db: deps.db });
  }

  if (deps.mcp) {
    await app.register(mcpRoutes, { ...deps.mcp, db: deps.db });
    await app.register(oauthRoutes, {
      db: deps.db,
      publicBaseUrl: deps.mcp.publicBaseUrl,
      assistantName: deps.mcp.settings.assistantName,
    });
  }

  return app;
}

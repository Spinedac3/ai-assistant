import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerHookHandler } from "fastify";
import fp from "fastify-plugin";
import type { TokenSigner, VerifiedAccess } from "../auth/tokens.js";
import type { Database } from "../db/client.js";
import { resolveUser } from "../permissions/resolve.js";

export interface AuthUser {
  id: number;
  email: string;
  displayName: string;
  role: string | null;
  scopes: Set<string>;
  systemCode?: string;
}

declare module "fastify" {
  interface FastifyRequest {
    authUser: AuthUser | null;
  }
  interface FastifyInstance {
    requireAuth: preHandlerHookHandler;
    requireScope: (scope: string) => preHandlerHookHandler;
  }
}

export interface AuthPluginOptions {
  db: Database;
  signer: TokenSigner;
}

/**
 * Registers the request guards that turn a bearer token into an authenticated user
 *
 * @param   app      Fastify instance
 * @param   options  Database and token signer
 */
async function authPlugin(app: FastifyInstance, options: AuthPluginOptions): Promise<void> {
  const { db, signer } = options;
  // Renews when a third of the lifetime is left, so an active session never drops mid-task
  const renewWithinMs = (signer.ttlSeconds * 1000) / 3;

  app.decorateRequest("authUser", null);

  app.decorate("requireAuth", async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return reply.code(401).send({ ok: false, error: "missing_token" });
    }

    let claims: VerifiedAccess;
    try {
      claims = await signer.verify(header.slice("Bearer ".length));
    } catch {
      return reply.code(401).send({ ok: false, error: "invalid_token" });
    }

    // The database wins over the token: role, scope and deactivation changes apply at once
    const user = await resolveUser(db, claims.sub);
    if (!user) {
      return reply.code(401).send({ ok: false, error: "unknown_identity" });
    }

    // The cut-off is stored in whole seconds, so a token from that same second is revoked too
    if (user.tokensRevokedAt && claims.iat * 1000 <= user.tokensRevokedAt.getTime()) {
      return reply.code(401).send({ ok: false, error: "token_revoked" });
    }

    if (!user.active) {
      return reply.code(403).send({ ok: false, error: "user_inactive" });
    }

    request.authUser = {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      role: user.roleCode,
      scopes: user.scopes,
      systemCode: claims.systemCode,
    };

    if (claims.exp * 1000 - Date.now() < renewWithinMs) {
      const renewed = await signer.sign({
        sub: user.id,
        role: user.roleCode,
        scopes: [...user.scopes],
        email: user.email,
        systemCode: claims.systemCode,
      });
      reply.header("x-renewed-token", renewed);
    }
  });

  app.decorate("requireScope", (scope: string) => {
    return async (request: FastifyRequest, reply: FastifyReply) => {
      if (!request.authUser?.scopes.has(scope)) {
        return reply.code(403).send({ ok: false, error: "missing_scope", scope });
      }
    };
  });
}

export default fp(authPlugin, { name: "auth", fastify: "5.x" });

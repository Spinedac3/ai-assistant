import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import { loginWithPassword, userForIdentity } from "../auth/accounts.js";
import {
  type ExternalSystem,
  type SystemIdentity,
  SystemTokenError,
  verifySystemToken,
} from "../auth/externalSystems.js";
import type { TokenSigner } from "../auth/tokens.js";
import type { Database } from "../db/client.js";
import { users } from "../db/schema.js";
import { resolveUser } from "../permissions/resolve.js";

export interface AuthRoutesOptions {
  db: Database;
  signer: TokenSigner;
  systems: Map<string, ExternalSystem>;
}

const loginBody = z.object({
  email: z.string().min(3).max(255),
  password: z.string().min(1).max(1024),
});

const systemLoginBody = z.object({ token: z.string().min(10).max(8192) });

/**
 * Registers login, identity and key publication routes
 *
 * @param   app      Fastify instance
 * @param   options  Database, token signer and external systems
 */
export default async function authRoutes(
  app: FastifyInstance,
  options: AuthRoutesOptions,
): Promise<void> {
  const { db, signer, systems } = options;

  /**
   * Issues an access token for a resolved user
   *
   * @param   userId      User to sign for
   * @param   systemCode  System the login came through, if any
   *
   * @return  The response body, or null when the user cannot sign in
   */
  const issue = async (userId: number, systemCode?: string) => {
    const user = await resolveUser(db, userId);
    if (!user?.active) {
      return null;
    }

    const token = await signer.sign({
      sub: user.id,
      role: user.roleCode,
      scopes: [...user.scopes],
      email: user.email,
      systemCode,
    });

    return {
      ok: true,
      data: {
        token,
        expiresIn: signer.ttlSeconds,
        user: {
          id: user.id,
          email: user.email,
          displayName: user.displayName,
          role: user.roleCode,
          scopes: [...user.scopes],
        },
      },
    };
  };

  app.get("/.well-known/jwks.json", async () => signer.jwks());

  app.post("/auth/login", async (request, reply) => {
    const body = loginBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }

    const login = await loginWithPassword(db, body.data.email, body.data.password);

    if (login.outcome !== "ok") {
      await logAudit(db, {
        userId: login.userId,
        level: "warn",
        eventCode: `auth.login_${login.outcome}`,
        message: "Intento de login rechazado",
        ip: request.ip,
      });

      // One message for every failure, so the answer never tells which accounts exist
      return reply.code(401).send({
        ok: false,
        error: "invalid_credentials",
        message: "Correo o contraseña incorrectos",
      });
    }

    const response = await issue(login.userId);
    if (!response) {
      return reply.code(403).send({ ok: false, error: "user_inactive" });
    }

    await logAudit(db, {
      userId: login.userId,
      level: "info",
      eventCode: "auth.login_ok",
      message: "Login con contraseña",
      ip: request.ip,
    });

    return response;
  });

  app.post("/auth/system-login", async (request, reply) => {
    const body = systemLoginBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }

    let identity: SystemIdentity;
    try {
      identity = await verifySystemToken(body.data.token, systems);
    } catch (error) {
      if (!(error instanceof SystemTokenError)) {
        throw error;
      }

      await logAudit(db, {
        userId: null,
        level: "warn",
        eventCode: "auth.system_token_invalid",
        message: error.message,
        ip: request.ip,
      });

      return reply.code(401).send({ ok: false, error: error.code });
    }

    const system = systems.get(identity.systemCode);
    const resolved = system ? await userForIdentity(db, system, identity) : null;

    if (!resolved) {
      await logAudit(db, {
        userId: null,
        level: "warn",
        eventCode: "auth.unknown_identity",
        message: `Sin usuario para ${identity.systemCode}:${identity.externalId}`,
        systemCode: identity.systemCode,
        ip: request.ip,
      });

      return reply.code(403).send({ ok: false, error: "unknown_identity" });
    }

    const response = await issue(resolved.userId, identity.systemCode);
    if (!response) {
      return reply.code(403).send({ ok: false, error: "user_inactive" });
    }

    await logAudit(db, {
      userId: resolved.userId,
      level: "info",
      eventCode: resolved.created ? "auth.user_provisioned" : "auth.login_ok",
      message: `Login desde ${identity.systemCode}`,
      systemCode: identity.systemCode,
      ip: request.ip,
    });

    return response;
  });

  app.get("/auth/me", { preHandler: app.requireAuth }, async (request) => {
    const user = request.authUser;

    return {
      ok: true,
      data: {
        id: user?.id,
        email: user?.email,
        displayName: user?.displayName,
        role: user?.role,
        scopes: [...(user?.scopes ?? [])],
      },
    };
  });

  app.post("/auth/sessions/revoke", { preHandler: app.requireAuth }, async (request) => {
    const userId = request.authUser?.id ?? 0;

    // Tokens carry whole seconds, so the cut-off is stored in whole seconds as well
    await db
      .update(users)
      .set({ tokensRevokedAt: sql`date_trunc('second', now())` })
      .where(eq(users.id, userId));

    await logAudit(db, {
      userId,
      level: "info",
      eventCode: "auth.sessions_revoked",
      message: "Cerró todas sus sesiones",
      ip: request.ip,
    });

    return { ok: true };
  });
}

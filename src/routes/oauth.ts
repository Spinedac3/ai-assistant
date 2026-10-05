import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import { loginWithPassword } from "../auth/accounts.js";
import { CONSENT_HEADERS, type ConsentRequest, consentPage } from "../auth/consentPage.js";
import { consumeCode, createCode, verifyPkce } from "../auth/oauthCodes.js";
import { generateToken, hashToken } from "../auth/opaqueTokens.js";
import type { Database } from "../db/client.js";
import { accessTokens, oauthClients, users } from "../db/schema.js";

export interface OAuthRoutesOptions {
  db: Database;
  publicBaseUrl: string;
  assistantName: string;
}

const ACCESS_TTL_SECONDS = 3_600;
const REFRESH_TTL_SECONDS = 90 * 86_400;

// Registration is open to any https or loopback client, audited instead of allowlisted: an
// allowlist would need a person to approve every new MCP client. Each grant still needs a real
// sign-in and an explicit consent, and what the token may do is decided by the person's own role
const REGISTER_WINDOW_MS = 10 * 60_000;
const REGISTER_MAX = 10;

const registerBody = z.object({
  redirect_uris: z.array(z.string().url()).min(1).max(10),
  client_name: z.string().trim().max(200).optional(),
});

const authorizeFields = {
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43).max(128),
  state: z.string().max(512).optional(),
  resource: z.string().max(512).optional(),
};

const authorizeQuery = z.object({
  ...authorizeFields,
  response_type: z.literal("code"),
  code_challenge_method: z.literal("S256"),
  scope: z.string().max(512).optional(),
});

const consentBody = z.object({
  ...authorizeFields,
  decision: z.enum(["approve", "deny"]),
  email: z.string().max(255).optional(),
  password: z.string().max(1024).optional(),
});

/**
 * Builds a counter of client registrations per IP over a sliding window
 *
 * @return  A check that counts the call and tells whether to refuse it
 */
function registrationLimiter(): (ip: string) => boolean {
  const registrations = new Map<string, number[]>();

  return (ip) => {
    const now = Date.now();
    const fresh = (times: number[]) => times.filter((at) => now - at < REGISTER_WINDOW_MS);

    // Addresses that went quiet are dropped, so the map stays as small as the recent traffic
    for (const [address, times] of registrations) {
      if (fresh(times).length === 0) {
        registrations.delete(address);
      }
    }

    const recent = fresh(registrations.get(ip) ?? []);
    recent.push(now);
    registrations.set(ip, recent);

    return recent.length > REGISTER_MAX;
  };
}

/**
 * Accepts https redirects and plain http only back to this machine, where CLI clients listen
 *
 * @param   uri  Redirect URI
 *
 * @return  Whether it is allowed
 */
export function allowedRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);

    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

/**
 * Registers the OAuth 2.1 authorization server that MCP clients use to obtain tokens
 *
 * @param   app      Fastify instance
 * @param   options  Database, public address and assistant name
 */
export default async function oauthRoutes(
  app: FastifyInstance,
  options: OAuthRoutesOptions,
): Promise<void> {
  const { db, publicBaseUrl, assistantName } = options;
  const resource = `${publicBaseUrl}/mcp`;
  const tooManyRegistrations = registrationLimiter();

  // Token requests and the consent form arrive as form posts; scoped to this plugin
  app.addContentTypeParser(
    "application/x-www-form-urlencoded",
    { parseAs: "string" },
    (_request, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
  );

  // A resource indicator, when sent, must name this server, so the token cannot be replayed elsewhere
  const resourceOk = (value: unknown) =>
    value === undefined || value === "" || value === resource || value === `${resource}/`;

  const findClient = async (clientId: string) => {
    const [row] = await db
      .select({ name: oauthClients.clientName, redirectUris: oauthClients.redirectUris })
      .from(oauthClients)
      .where(eq(oauthClients.clientId, clientId))
      .limit(1);

    return row ?? null;
  };

  /**
   * Sends the person back to the client with the result, naming the issuer against mix-up attacks
   *
   * @param   reply        Reply
   * @param   redirectUri  Validated client redirect
   * @param   params       Result parameters
   *
   * @return  The redirect reply
   */
  const backToClient = (
    reply: FastifyReply,
    redirectUri: string,
    params: Record<string, string | undefined>,
  ) => {
    const url = new URL(redirectUri);
    for (const [name, value] of Object.entries({ ...params, iss: publicBaseUrl })) {
      if (value !== undefined) {
        url.searchParams.set(name, value);
      }
    }

    return reply.redirect(url.toString(), 303);
  };

  const issueTokens = async (userId: number, clientId: string) => {
    const access = generateToken("ast");
    const refresh = generateToken("asr");
    await db.insert(accessTokens).values({
      userId,
      clientId,
      accessTokenHash: hashToken(access),
      refreshTokenHash: hashToken(refresh),
      kind: "oauth",
      accessExpiresAt: sql`now() + make_interval(secs => ${ACCESS_TTL_SECONDS})`,
      refreshExpiresAt: sql`now() + make_interval(secs => ${REFRESH_TTL_SECONDS})`,
    });

    return {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
    };
  };

  app.get("/.well-known/oauth-protected-resource", async () => ({
    resource,
    authorization_servers: [publicBaseUrl],
    bearer_methods_supported: ["header"],
  }));

  app.get("/.well-known/oauth-authorization-server", async () => ({
    issuer: publicBaseUrl,
    authorization_endpoint: `${publicBaseUrl}/oauth/authorize`,
    token_endpoint: `${publicBaseUrl}/oauth/token`,
    registration_endpoint: `${publicBaseUrl}/oauth/register`,
    revocation_endpoint: `${publicBaseUrl}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    authorization_response_iss_parameter_supported: true,
  }));

  app.post("/oauth/register", async (request, reply) => {
    if (tooManyRegistrations(request.ip)) {
      return reply.code(429).send({ error: "rate_limited" });
    }

    const body = registerBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_client_metadata" });
    }

    if (!body.data.redirect_uris.every(allowedRedirect)) {
      return reply.code(400).send({
        error: "invalid_redirect_uri",
        error_description: "Solo se permiten redirect URIs https o de esta máquina (localhost)",
      });
    }

    const clientId = `mcp_${generateToken("asc").slice(4, 28)}`;
    await db.insert(oauthClients).values({
      clientId,
      clientName: body.data.client_name ?? null,
      redirectUris: body.data.redirect_uris,
    });

    await logAudit(db, {
      userId: null,
      level: "info",
      eventCode: "oauth.client_registered",
      message: `${body.data.client_name ?? "(sin nombre)"} (${clientId}) → ${body.data.redirect_uris.join(", ")}`,
      ip: request.ip,
    });

    return reply.code(201).send({
      client_id: clientId,
      client_name: body.data.client_name,
      redirect_uris: body.data.redirect_uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    });
  });

  app.get("/oauth/authorize", async (request, reply) => {
    const query = authorizeQuery.safeParse(request.query);
    // Without a validated redirect the error cannot go back to the client, so it goes to the browser
    if (!query.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    const client = await findClient(query.data.client_id);
    if (!client?.redirectUris.includes(query.data.redirect_uri)) {
      return reply.code(400).send({ error: "invalid_client" });
    }

    if (!resourceOk(query.data.resource)) {
      return backToClient(reply, query.data.redirect_uri, {
        error: "invalid_target",
        state: query.data.state,
      });
    }

    const consent: ConsentRequest = {
      clientId: query.data.client_id,
      clientName: client.name ?? "Una aplicación",
      redirectUri: query.data.redirect_uri,
      codeChallenge: query.data.code_challenge,
      state: query.data.state,
      resource: query.data.resource,
    };

    return reply.code(200).headers(CONSENT_HEADERS).send(consentPage(assistantName, consent));
  });

  app.post("/oauth/authorize", async (request, reply) => {
    const body = consentBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid_request" });
    }

    // The hidden fields came back from the browser, so they are validated again, never trusted
    const client = await findClient(body.data.client_id);
    if (!client?.redirectUris.includes(body.data.redirect_uri) || !resourceOk(body.data.resource)) {
      return reply.code(400).send({ error: "invalid_client" });
    }

    if (body.data.decision === "deny") {
      await logAudit(db, {
        userId: null,
        level: "info",
        eventCode: "oauth.consent_denied",
        message: `Consentimiento rechazado para ${body.data.client_id}`,
        ip: request.ip,
      });

      return backToClient(reply, body.data.redirect_uri, {
        error: "access_denied",
        state: body.data.state,
      });
    }

    const login = await loginWithPassword(db, body.data.email ?? "", body.data.password ?? "");
    if (login.outcome !== "ok") {
      await logAudit(db, {
        userId: login.userId,
        level: "warn",
        eventCode: `oauth.login_${login.outcome}`,
        message: `Login rechazado en el consentimiento de ${body.data.client_id}`,
        ip: request.ip,
      });

      const consent: ConsentRequest = {
        clientId: body.data.client_id,
        clientName: client.name ?? "Una aplicación",
        redirectUri: body.data.redirect_uri,
        codeChallenge: body.data.code_challenge,
        state: body.data.state,
        resource: body.data.resource,
      };

      return reply
        .code(401)
        .headers(CONSENT_HEADERS)
        .send(consentPage(assistantName, consent, "Correo o contraseña incorrectos"));
    }

    const code = createCode({
      clientId: body.data.client_id,
      userId: login.userId,
      redirectUri: body.data.redirect_uri,
      codeChallenge: body.data.code_challenge,
    });

    await logAudit(db, {
      userId: login.userId,
      level: "info",
      eventCode: "oauth.consent_granted",
      message: `Consentimiento a ${client.name ?? body.data.client_id}`,
      ip: request.ip,
    });

    return backToClient(reply, body.data.redirect_uri, { code, state: body.data.state });
  });

  app.post("/oauth/token", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const text = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : "");
    reply.header("Cache-Control", "no-store");

    if (!resourceOk(body.resource)) {
      return reply.code(400).send({ error: "invalid_target" });
    }

    if (body.grant_type === "authorization_code") {
      const pending = consumeCode(text("code"));

      // One answer for every cause, so the endpoint is no oracle of which check failed
      if (
        !pending ||
        pending.clientId !== text("client_id") ||
        pending.redirectUri !== text("redirect_uri") ||
        !verifyPkce(text("code_verifier"), pending.codeChallenge)
      ) {
        return reply.code(400).send({ error: "invalid_grant" });
      }

      await logAudit(db, {
        userId: pending.userId,
        level: "info",
        eventCode: "oauth.token_issued",
        message: `Tokens para ${pending.clientId}`,
        ip: request.ip,
      });

      return issueTokens(pending.userId, pending.clientId);
    }

    if (body.grant_type === "refresh_token") {
      const presented = hashToken(text("refresh_token"));
      const [current] = await db
        .select({ id: accessTokens.id, clientId: accessTokens.clientId })
        .from(accessTokens)
        .innerJoin(users, eq(users.id, accessTokens.userId))
        .where(
          and(
            eq(accessTokens.refreshTokenHash, presented),
            eq(accessTokens.kind, "oauth"),
            isNull(accessTokens.revokedAt),
            gt(accessTokens.refreshExpiresAt, sql`now()`),
            // The same cut-off /mcp applies, so a revoked or disabled person gets no fresh tokens
            eq(users.active, true),
            isNull(users.deletedAt),
            or(
              isNull(users.tokensRevokedAt),
              gt(sql`date_trunc('second', ${accessTokens.createdAt})`, users.tokensRevokedAt),
            ),
          ),
        )
        .limit(1);

      if (current && text("client_id") === current.clientId) {
        const access = generateToken("ast");
        const refresh = generateToken("asr");
        // Rotated in place: the session keeps its birth time, so revoking sessions still reaches it.
        // Conditioned on the presented hash, so of two concurrent refreshes only one wins
        const rotated = await db
          .update(accessTokens)
          .set({
            previousRefreshHash: presented,
            accessTokenHash: hashToken(access),
            refreshTokenHash: hashToken(refresh),
            accessExpiresAt: sql`now() + make_interval(secs => ${ACCESS_TTL_SECONDS})`,
            refreshExpiresAt: sql`now() + make_interval(secs => ${REFRESH_TTL_SECONDS})`,
          })
          .where(and(eq(accessTokens.id, current.id), eq(accessTokens.refreshTokenHash, presented)))
          .returning({ id: accessTokens.id });

        if (rotated.length === 1) {
          return {
            access_token: access,
            token_type: "Bearer",
            expires_in: ACCESS_TTL_SECONDS,
            refresh_token: refresh,
          };
        }
      }

      // A refresh token that was already rotated came back: someone holds a stolen copy
      const [reused] = await db
        .select({ id: accessTokens.id, userId: accessTokens.userId })
        .from(accessTokens)
        .where(and(eq(accessTokens.previousRefreshHash, presented), isNull(accessTokens.revokedAt)))
        .limit(1);

      if (reused) {
        await db
          .update(accessTokens)
          .set({ revokedAt: sql`now()` })
          .where(eq(accessTokens.id, reused.id));
        await logAudit(db, {
          userId: reused.userId,
          level: "warn",
          eventCode: "oauth.refresh_reuse",
          message: `Refresh reutilizado: sesión ${reused.id} revocada`,
          ip: request.ip,
        });
      }

      return reply.code(400).send({ error: "invalid_grant" });
    }

    return reply.code(400).send({ error: "unsupported_grant_type" });
  });

  app.post("/oauth/revoke", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const token = typeof body.token === "string" ? body.token : "";

    if (token !== "") {
      const hash = hashToken(token);
      await db
        .update(accessTokens)
        .set({ revokedAt: sql`now()` })
        .where(
          and(
            eq(accessTokens.kind, "oauth"),
            or(eq(accessTokens.accessTokenHash, hash), eq(accessTokens.refreshTokenHash, hash)),
            isNull(accessTokens.revokedAt),
          ),
        );
    }

    // Always 200, as the spec requires, so it never tells whether a token existed
    return reply.code(200).send({});
  });
}

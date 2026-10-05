import { randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import { loginWithPassword } from "../auth/accounts.js";
import { type ConsentRequest, consentHeaders, consentPage } from "../auth/consentPage.js";
import { consumeCode, createCode, verifyPkce } from "../auth/oauthCodes.js";
import { generateToken, hashToken } from "../auth/opaqueTokens.js";
import type { Database } from "../db/client.js";
import { accessTokens, oauthClients, users } from "../db/schema.js";

export interface OAuthRoutesOptions {
  db: Database;
  publicBaseUrl: string;
  assistantName: string;
}

// Ties the consent post to the browser that loaded the page. Over https the __Host- prefix keeps a
// sibling subdomain from planting its own value
const CSRF_COOKIE = "oauth_consent";
const CSRF_SHAPE = /^[A-Za-z0-9_-]{32}$/;
const CSRF_TTL_SECONDS = 10 * 60;

const ACCESS_TTL_SECONDS = 3_600;
const REFRESH_TTL_SECONDS = 90 * 86_400;

// Registration is open to any https or loopback client, audited instead of allowlisted: an
// allowlist would need a person to approve every new MCP client. Each grant still needs a real
// sign-in and an explicit consent, and what the token may do is decided by the person's own role
const REGISTER_WINDOW_MS = 10 * 60_000;
const REGISTER_MAX = 10;

const LOOPBACK = ["localhost", "127.0.0.1", "[::1]"];

// How long after a rotation the previous refresh is taken as the client racing itself
const REUSE_GRACE_SECONDS = 10;

const registerBody = z.object({
  redirect_uris: z.array(z.string().url().max(2048)).min(1).max(10),
  client_name: z
    .string()
    .trim()
    .max(200)
    .optional()
    .transform((name) => name || undefined),
});

const authorizeFields = {
  client_id: z.string().min(1).max(64),
  redirect_uri: z.string().url(),
  code_challenge: z.string().min(43).max(128),
  state: z.string().max(512).optional(),
  resource: z.string().max(512).optional(),
};

type AuthorizeFields = z.infer<z.ZodObject<typeof authorizeFields>>;

const authorizeQuery = z.object({
  ...authorizeFields,
  response_type: z.literal("code"),
  code_challenge_method: z.literal("S256"),
  scope: z.string().max(512).optional(),
});

const consentBody = z.object({
  ...authorizeFields,
  decision: z.enum(["approve", "deny"]),
  csrf: z.string().min(1).max(64),
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
      url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK.includes(url.hostname))
    );
  } catch {
    return false;
  }
}

/**
 * Creates an access and refresh token pair, with the columns that store it and the response
 *
 * @return  The columns and the token response
 */
function newTokenPair() {
  const access = generateToken("ast");
  const refresh = generateToken("asr");

  return {
    columns: {
      accessTokenHash: hashToken(access),
      refreshTokenHash: hashToken(refresh),
      accessExpiresAt: sql`now() + make_interval(secs => ${ACCESS_TTL_SECONDS})`,
      refreshExpiresAt: sql`now() + make_interval(secs => ${REFRESH_TTL_SECONDS})`,
    },
    response: {
      access_token: access,
      token_type: "Bearer",
      expires_in: ACCESS_TTL_SECONDS,
      refresh_token: refresh,
    },
  };
}

/**
 * Tells whether a redirect URI is one the client registered
 *
 * @param   registered  Registered redirect URIs
 * @param   uri         Presented redirect URI
 *
 * @return  Whether it matches
 */
export function registeredRedirect(registered: string[], uri: string): boolean {
  if (registered.includes(uri)) {
    return true;
  }

  // On loopback the port may change: native clients listen on whatever port is free

  const portless = (value: string) => {
    const url = new URL(value);
    if (url.protocol !== "http:" || !LOOPBACK.includes(url.hostname)) {
      return null;
    }

    url.port = "";
    return url.toString();
  };

  const presented = portless(uri);

  return presented !== null && registered.some((entry) => portless(entry) === presented);
}

/**
 * Reads one cookie from the request header
 *
 * @param   header  Cookie header, if any
 * @param   name    Cookie name
 *
 * @return  Its value, or an empty string when missing or sent more than once
 */
function cookieValue(header: string | undefined, name: string): string {
  const values = (header ?? "")
    .split(";")
    .map((pair) => pair.trim().split("="))
    .filter(([key]) => key === name)
    .map(([, ...rest]) => rest.join("="));

  // Two cookies with one name means someone planted one; neither is trusted
  return values.length === 1 ? (values[0] ?? "") : "";
}

/**
 * Compares two secrets in constant time
 *
 * @param   left   First value
 * @param   right  Second value
 *
 * @return  Whether both are non-empty and equal
 */
function sameValue(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);

  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
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
  const https = publicBaseUrl.startsWith("https:");
  const csrfCookie = https ? `__Host-${CSRF_COOKIE}` : CSRF_COOKIE;
  const cookieScope = https ? "Path=/; Secure" : "Path=/oauth/authorize";

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

  // Sends the person back to the client, naming the issuer against mix-up attacks
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
    const pair = newTokenPair();
    await db.insert(accessTokens).values({ ...pair.columns, userId, clientId, kind: "oauth" });

    return pair.response;
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
      return reply
        .code(429)
        .header("Retry-After", String(REGISTER_WINDOW_MS / 1000))
        .send({
          error: "rate_limited",
          error_description: "Demasiados registros, intenta más tarde",
        });
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

    const clientId = `mcp_${randomBytes(18).toString("base64url")}`;
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

  // Renders the consent page; the csrf value is the one bound to this browser cookie
  const showConsent = (
    reply: FastifyReply,
    fields: AuthorizeFields,
    client: { name: string | null },
    csrf: string,
    error?: string,
  ) => {
    const consent: ConsentRequest = {
      clientId: fields.client_id,
      clientName: client.name ?? "Una aplicación",
      redirectUri: fields.redirect_uri,
      codeChallenge: fields.code_challenge,
      state: fields.state,
      resource: fields.resource,
      csrf,
    };

    return reply
      .code(error ? 401 : 200)
      .headers(consentHeaders(fields.redirect_uri))
      .send(consentPage(assistantName, consent, error));
  };

  app.get("/oauth/authorize", async (request, reply) => {
    const query = authorizeQuery.safeParse(request.query);
    // Errors before consent stay in the browser: redirecting them would turn this server into a
    // redirector to any URI an anonymous client registered
    if (!query.success) {
      return reply.code(400).send({
        error: "invalid_request",
        error_description: "Solicitud de autorización inválida",
      });
    }

    const client = await findClient(query.data.client_id);
    if (!client || !registeredRedirect(client.redirectUris, query.data.redirect_uri)) {
      return reply.code(400).send({
        error: "invalid_client",
        error_description: "Aplicación o redirect no registrados",
      });
    }

    if (!resourceOk(query.data.resource)) {
      return reply.code(400).send({
        error: "invalid_target",
        error_description: "El recurso pedido no es este servidor",
      });
    }

    // A page already open in another tab keeps working: its value is reused, not replaced
    const current = cookieValue(request.headers.cookie, csrfCookie);
    const csrf = CSRF_SHAPE.test(current) ? current : randomBytes(24).toString("base64url");
    reply.header(
      "Set-Cookie",
      `${csrfCookie}=${csrf}; ${cookieScope}; Max-Age=${CSRF_TTL_SECONDS}; HttpOnly; SameSite=Strict`,
    );

    return showConsent(reply, query.data, client, csrf);
  });

  app.post("/oauth/authorize", async (request, reply) => {
    const body = consentBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        error: "invalid_request",
        error_description: "Solicitud de autorización inválida",
      });
    }

    // Only a post from the page this browser loaded gets through; a forged one cannot redirect
    if (!sameValue(cookieValue(request.headers.cookie, csrfCookie), body.data.csrf)) {
      return reply.code(403).send({
        error: "invalid_request",
        error_description:
          "La página de autorización venció; vuelve a intentarlo desde la aplicación",
      });
    }

    // The hidden fields came back from the browser, so they are validated again, never trusted
    const client = await findClient(body.data.client_id);
    if (
      !client ||
      !registeredRedirect(client.redirectUris, body.data.redirect_uri) ||
      !resourceOk(body.data.resource)
    ) {
      return reply.code(400).send({
        error: "invalid_client",
        error_description: "Aplicación o redirect no registrados",
      });
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

      return showConsent(
        reply,
        body.data,
        client,
        body.data.csrf,
        "Correo o contraseña incorrectos",
      );
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

      if (current) {
        if (text("client_id") !== current.clientId) {
          return reply.code(400).send({ error: "invalid_grant" });
        }

        const pair = newTokenPair();
        // Rotated in place: the session keeps its birth time, so revoking sessions still reaches it.
        // Conditioned on the presented hash: of two concurrent refreshes, the loser just fails
        const rotated = await db
          .update(accessTokens)
          .set({ ...pair.columns, previousRefreshHash: presented, rotatedAt: sql`now()` })
          .where(and(eq(accessTokens.id, current.id), eq(accessTokens.refreshTokenHash, presented)))
          .returning({ id: accessTokens.id });

        return rotated.length === 1
          ? pair.response
          : reply.code(400).send({ error: "invalid_grant" });
      }

      // The refresh before the last rotation came back. Seconds after rotating it is a client that
      // raced itself; later, someone holds a stolen copy
      const [reused] = await db
        .select({ id: accessTokens.id, userId: accessTokens.userId })
        .from(accessTokens)
        .where(
          and(
            eq(accessTokens.previousRefreshHash, presented),
            isNull(accessTokens.revokedAt),
            sql`${accessTokens.rotatedAt} < now() - make_interval(secs => ${REUSE_GRACE_SECONDS})`,
          ),
        )
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

    return reply.code(400).send({
      error: body.grant_type === undefined ? "invalid_request" : "unsupported_grant_type",
    });
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

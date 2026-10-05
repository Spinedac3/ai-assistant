import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashToken } from "../../src/auth/opaqueTokens.js";
import { hashPassword } from "../../src/auth/password.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { accessTokens, auditLogs, roles, users } from "../../src/db/schema.js";
import { calculateTool } from "../../src/tools/native/calculate.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const BASE = "https://assistant.example.com";
const RESOURCE = `${BASE}/mcp`;
const REDIRECT = "https://client.example.com/callback";
const PASSWORD = "tres caballos verdes";
const VERIFIER = "a-verifier-of-enough-length-for-pkce-0123456789abcdef";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let database: DatabaseHandle;
let app: FastifyInstance;
let clientId: string;

/**
 * Creates a user with a password
 *
 * @param   email  Login email
 *
 * @return  The user id
 */
async function createUser(email: string): Promise<number> {
  const [role] = await database.db.select().from(roles).where(eq(roles.code, "user"));
  const [row] = await database.db
    .insert(users)
    .values({
      email,
      displayName: email,
      passwordHash: await hashPassword(PASSWORD),
      primaryRoleId: role?.id ?? null,
    })
    .returning({ id: users.id });

  return row?.id ?? 0;
}

/**
 * Posts a form, the way browsers and OAuth clients send it
 *
 * @param   url     Endpoint
 * @param   fields  Form fields
 * @param   cookie  Cookie header, if any
 *
 * @return  The response
 */
function form(url: string, fields: Record<string, string>, cookie?: string) {
  return app.inject({
    method: "POST",
    url,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    payload: new URLSearchParams(fields).toString(),
  });
}

/**
 * Opens the consent page as a browser would
 *
 * @param   extra  Query parameters to add or override
 *
 * @return  The response
 */
function openPage(extra: Record<string, string> = {}) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "xyz",
    resource: RESOURCE,
    ...extra,
  });

  return app.inject({ url: `/oauth/authorize?${query}` });
}

/**
 * Loads the consent page and submits it from the same browser
 *
 * @param   extra  Form fields to add or override
 *
 * @return  The response to the submission
 */
async function consent(extra: Record<string, string> = {}) {
  const page = await openPage();
  const cookie = String(page.headers["set-cookie"]).split(";")[0] ?? "";
  const csrf = /name="csrf" value="([^"]+)"/.exec(page.body)?.[1] ?? "";

  return form(
    "/oauth/authorize",
    {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      state: "xyz",
      resource: RESOURCE,
      csrf,
      decision: "approve",
      email: "ana@example.com",
      password: PASSWORD,
      ...extra,
    },
    cookie,
  );
}

/**
 * Takes the code out of a consent redirect
 *
 * @param   response  Consent response
 *
 * @return  The code
 */
function codeFrom(response: { headers: Record<string, unknown> }): string {
  return new URL(String(response.headers.location)).searchParams.get("code") ?? "";
}

/**
 * Exchanges a code for tokens
 *
 * @param   code   Authorization code
 * @param   extra  Fields to add or override
 *
 * @return  The response
 */
function exchange(code: string, extra: Record<string, string> = {}) {
  return form("/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: RESOURCE,
    ...extra,
  });
}

/**
 * Runs the consent and the code exchange
 *
 * @param   email  Who consents
 *
 * @return  The token response body
 */
async function obtainTokens(email = "ana@example.com") {
  return (await exchange(codeFrom(await consent({ email })))).json();
}

/**
 * Asks for a new pair with a refresh token
 *
 * @param   token  Refresh token
 * @param   client  Client id
 *
 * @return  The response
 */
function refresh(token: string, client = clientId) {
  return form("/oauth/token", {
    grant_type: "refresh_token",
    refresh_token: token,
    client_id: client,
  });
}

/**
 * Lists tools over MCP with a bearer token
 *
 * @param   token  Access token
 *
 * @return  The response
 */
function listTools(token: string) {
  return app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    payload: { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
  });
}

/**
 * Registers a client
 *
 * @param   redirectUris  Redirect URIs
 *
 * @return  The response
 */
function register(redirectUris: string[]) {
  return app.inject({
    method: "POST",
    url: "/oauth/register",
    payload: { redirect_uris: redirectUris, client_name: "Cliente de prueba" },
  });
}

describe("oauth", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    await createUser("ana@example.com");

    const registry = new ToolRegistry(database.db);
    registry.register(calculateTool);
    app = await buildApp({
      db: database.db,
      signer: testSigner(),
      systems: new Map(),
      mcp: {
        registry,
        publicBaseUrl: BASE,
        settings: {
          assistantName: "Lumen",
          organizationContext: null,
          timeZone: "UTC",
          accessContact: async () => "rrhh@example.com",
        },
      },
    });

    clientId = (await register([REDIRECT])).json().client_id;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("publishes the metadata a client needs to discover the flow", async () => {
    // Performs the test.
    const resource = await app.inject({ url: "/.well-known/oauth-protected-resource" });
    const server = await app.inject({ url: "/.well-known/oauth-authorization-server" });

    // Performs assertions.
    expect(resource.json()).toMatchObject({ resource: RESOURCE, authorization_servers: [BASE] });
    expect(server.json()).toMatchObject({
      issuer: BASE,
      token_endpoint: `${BASE}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("refuses to register a plain http redirect to another host", async () => {
    // Performs the test.
    const response = await register(["http://client.example.com/callback"]);

    // Performs assertions.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_redirect_uri");
  });

  it("shows the consent page bound to this browser, unframed and posting only to here or the client", async () => {
    // Performs the test.
    const response = await openPage();

    // Performs assertions.
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Cliente de prueba quiere usar Lumen");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain(
      "form-action 'self' https://client.example.com;",
    );
    expect(response.headers["set-cookie"]).toMatch(
      /^oauth_consent=.+HttpOnly; SameSite=Strict; Secure$/,
    );
  });

  it("keeps request errors in the browser instead of redirecting to the client", async () => {
    // Performs the test.
    const unregistered = await openPage({ redirect_uri: "https://attacker.example.com/callback" });
    const otherResource = await openPage({ resource: "https://other.example.com/mcp" });
    const plainPkce = await openPage({ code_challenge_method: "plain" });
    const implicit = await openPage({ response_type: "token" });

    // Performs assertions.
    expect(unregistered.statusCode).toBe(400);
    expect(otherResource.json().error).toBe("invalid_target");
    expect(plainPkce.statusCode).toBe(400);
    expect(implicit.statusCode).toBe(400);
    for (const response of [unregistered, otherResource, plainPkce, implicit]) {
      expect(response.headers.location).toBeUndefined();
    }
  });

  it("refuses a consent post that did not come from the page this browser loaded", async () => {
    // Performs the test.
    const response = await form("/oauth/authorize", {
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      csrf: "forged",
      decision: "deny",
    });

    // Performs assertions.
    expect(response.statusCode).toBe(403);
    expect(response.headers.location).toBeUndefined();
  });

  it("validates the hidden fields again when the form comes back", async () => {
    // Performs the test.
    const redirect = await consent({ redirect_uri: "https://attacker.example.com/callback" });
    const resource = await consent({ resource: "https://other.example.com/mcp" });

    // Performs assertions.
    expect(redirect.statusCode).toBe(400);
    expect(resource.statusCode).toBe(400);
    expect(redirect.headers.location).toBeUndefined();
    expect(resource.headers.location).toBeUndefined();
  });

  it("re-renders the page on a wrong password without issuing a code", async () => {
    // Performs the test.
    const response = await consent({ password: "otra contraseña larga" });

    // Performs assertions.
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Correo o contraseña incorrectos");
    expect(response.body).toMatch(/name="csrf" value="[^"]+"/);
    expect(response.headers.location).toBeUndefined();
  });

  it("returns access_denied when the person rejects", async () => {
    // Performs the test.
    const response = await consent({ decision: "deny" });
    const location = new URL(String(response.headers.location));

    // Performs assertions.
    expect(response.statusCode).toBe(303);
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("iss")).toBe(BASE);
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("issues tokens that open /mcp after consent and PKCE", async () => {
    // Performs the test.
    const approved = await consent();
    const location = new URL(String(approved.headers.location));
    const tokens = (await exchange(codeFrom(approved), { resource: `${RESOURCE}/` })).json();
    const tools = await listTools(tokens.access_token);

    // Performs assertions.
    expect(approved.statusCode).toBe(303);
    expect(location.searchParams.get("state")).toBe("xyz");
    expect(location.searchParams.get("iss")).toBe(BASE);
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toContain(
      "run_capability",
    );
  });

  it("answers the same invalid_grant for every way a code exchange can be wrong", async () => {
    // Performs the test.
    const reusedCode = codeFrom(await consent());
    await exchange(reusedCode);
    const responses = [
      await exchange(codeFrom(await consent()), { code_verifier: `${VERIFIER}x` }),
      await exchange(codeFrom(await consent()), { client_id: "mcp_other" }),
      await exchange(codeFrom(await consent()), {
        redirect_uri: "https://client.example.com/other",
      }),
      await exchange(reusedCode),
    ];

    // Performs assertions.
    for (const response of responses) {
      expect(response.statusCode).toBe(400);
      expect(response.json()).toEqual({ error: "invalid_grant" });
    }
  });

  it("refuses a token for another resource before spending the code", async () => {
    // Performs the test.
    const code = codeFrom(await consent());
    const other = await exchange(code, { resource: "https://other.example.com/mcp" });
    const right = await exchange(code);

    // Performs assertions.
    expect(other.json().error).toBe("invalid_target");
    expect(right.statusCode).toBe(200);
  });

  it("tells a missing grant type from an unsupported one", async () => {
    // Performs the test.
    const missing = await form("/oauth/token", {});
    const unknown = await form("/oauth/token", { grant_type: "password" });

    // Performs assertions.
    expect(missing.json().error).toBe("invalid_request");
    expect(unknown.json().error).toBe("unsupported_grant_type");
  });

  it("rotates the refresh token and revokes the session when an old one comes back later", async () => {
    // Performs the test.
    const first = await obtainTokens();
    const second = (await refresh(first.refresh_token)).json();
    await database.db
      .update(accessTokens)
      .set({ rotatedAt: sql`now() - interval '1 minute'` })
      .where(eq(accessTokens.refreshTokenHash, hashToken(second.refresh_token)));
    const replay = await refresh(first.refresh_token);
    const afterReplay = await refresh(second.refresh_token);
    const tools = await listTools(second.access_token);
    const [audit] = await database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.eventCode, "oauth.refresh_reuse"));

    // Performs assertions.
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(replay.json().error).toBe("invalid_grant");
    expect(afterReplay.json().error).toBe("invalid_grant");
    expect(tools.statusCode).toBe(401);
    expect(audit).toBeDefined();
  });

  it("keeps the session when a client races two refreshes with the same token", async () => {
    // Performs the test.
    const tokens = await obtainTokens();
    const results = await Promise.all([
      refresh(tokens.refresh_token),
      refresh(tokens.refresh_token),
    ]);
    const winner = results.find((response) => response.statusCode === 200)?.json();
    const late = await refresh(tokens.refresh_token);
    const tools = await listTools(winner?.access_token ?? "");

    // Performs assertions.
    expect(results.filter((response) => response.statusCode === 200)).toHaveLength(1);
    expect(late.json().error).toBe("invalid_grant");
    expect(tools.statusCode).toBe(200);
  });

  it("refuses to refresh for a revoked, disabled or expired session", async () => {
    // Performs the test.
    const betoId = await createUser("beto@example.com");
    const caroId = await createUser("caro@example.com");
    const revoked = await obtainTokens("beto@example.com");
    const disabled = await obtainTokens("caro@example.com");
    const expired = await obtainTokens();
    await database.db
      .update(users)
      .set({ tokensRevokedAt: sql`date_trunc('second', now())` })
      .where(eq(users.id, betoId));
    await database.db.update(users).set({ active: false }).where(eq(users.id, caroId));
    await database.db
      .update(accessTokens)
      .set({ refreshExpiresAt: sql`now() - interval '1 second'` })
      .where(eq(accessTokens.refreshTokenHash, hashToken(expired.refresh_token)));
    const responses = [
      await refresh(revoked.refresh_token),
      await refresh(disabled.refresh_token),
      await refresh(expired.refresh_token),
    ];

    // Performs assertions.
    for (const response of responses) {
      expect(response.json().error).toBe("invalid_grant");
    }
  });

  it("refuses a refresh from another client", async () => {
    // Performs the test.
    const tokens = await obtainTokens();
    const response = await refresh(tokens.refresh_token, "mcp_other");

    // Performs assertions.
    expect(response.json().error).toBe("invalid_grant");
  });

  it("revokes by access or refresh token and answers 200 even for an unknown one", async () => {
    // Performs the test.
    const byAccess = await obtainTokens();
    const byRefresh = await obtainTokens();
    const responses = [
      await form("/oauth/revoke", { token: byAccess.access_token }),
      await form("/oauth/revoke", { token: byRefresh.refresh_token }),
      await form("/oauth/revoke", { token: "asr_unknown" }),
    ];
    const accessTools = await listTools(byAccess.access_token);
    const refreshTools = await listTools(byRefresh.access_token);

    // Performs assertions.
    for (const response of responses) {
      expect(response.statusCode).toBe(200);
    }
    expect(accessTools.statusCode).toBe(401);
    expect(refreshTools.statusCode).toBe(401);
  });

  it("stops registrations from one address after ten in the window", async () => {
    // Performs the test.
    // Two registrations already happened in this suite
    const allowed: number[] = [];
    for (let attempt = 0; attempt < 8; attempt++) {
      allowed.push((await register([REDIRECT])).statusCode);
    }
    const refused = await register([REDIRECT]);

    // Performs assertions.
    expect(allowed).toEqual(Array(8).fill(201));
    expect(refused.statusCode).toBe(429);
    expect(refused.headers["retry-after"]).toBe("600");
  });
});

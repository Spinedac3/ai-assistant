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
const REDIRECT = "https://client.example.com/callback";
const PASSWORD = "tres caballos verdes";
const VERIFIER = "a-verifier-of-enough-length-for-pkce-0123456789abcdef";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

let database: DatabaseHandle;
let app: FastifyInstance;
let clientId: string;

/**
 * Posts a form, the way browsers and OAuth clients send it
 *
 * @param   url     Endpoint
 * @param   fields  Form fields
 *
 * @return  The response
 */
function form(url: string, fields: Record<string, string>) {
  return app.inject({
    method: "POST",
    url,
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams(fields).toString(),
  });
}

/**
 * Builds the consent form fields for a client
 *
 * @param   extra  Fields to add or override
 *
 * @return  The fields
 */
function consentFields(extra: Record<string, string> = {}) {
  return {
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: CHALLENGE,
    state: "xyz",
    resource: `${BASE}/mcp`,
    decision: "approve",
    email: "ana@example.com",
    password: PASSWORD,
    ...extra,
  };
}

/**
 * Runs the consent and the code exchange
 *
 * @return  The token response body
 */
async function obtainTokens() {
  const consent = await form("/oauth/authorize", consentFields());
  const code = new URL(consent.headers.location as string).searchParams.get("code") ?? "";
  const token = await form("/oauth/token", {
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_verifier: VERIFIER,
    resource: `${BASE}/mcp`,
  });

  return token.json();
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

describe("oauth", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    const [role] = await database.db.select().from(roles).where(eq(roles.code, "user"));
    await database.db.insert(users).values({
      email: "ana@example.com",
      displayName: "Ana",
      passwordHash: await hashPassword(PASSWORD),
      primaryRoleId: role?.id ?? null,
    });

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

    const registered = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { redirect_uris: [REDIRECT], client_name: "Cliente de prueba" },
    });
    clientId = registered.json().client_id;
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
    expect(resource.json()).toMatchObject({
      resource: `${BASE}/mcp`,
      authorization_servers: [BASE],
    });
    expect(server.json()).toMatchObject({
      issuer: BASE,
      token_endpoint: `${BASE}/oauth/token`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("refuses to register a plain http redirect to another host", async () => {
    // Performs the test.
    const response = await app.inject({
      method: "POST",
      url: "/oauth/register",
      payload: { redirect_uris: ["http://client.example.com/callback"] },
    });

    // Performs assertions.
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_redirect_uri");
  });

  it("shows the consent page with headers that forbid framing and scripts", async () => {
    // Performs the test.
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "xyz",
    });
    const response = await app.inject({ url: `/oauth/authorize?${query}` });

    // Performs assertions.
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Cliente de prueba quiere usar Lumen");
    expect(response.headers["x-frame-options"]).toBe("DENY");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
  });

  it("does not show the consent page for a redirect the client never registered", async () => {
    // Performs the test.
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: "https://attacker.example.com/callback",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });
    const response = await app.inject({ url: `/oauth/authorize?${query}` });

    // Performs assertions.
    expect(response.statusCode).toBe(400);
    expect(response.headers.location).toBeUndefined();
  });

  it("sends a wrong resource back to the client naming the issuer", async () => {
    // Performs the test.
    const query = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: REDIRECT,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      state: "xyz",
      resource: "https://other.example.com/mcp",
    });
    const response = await app.inject({ url: `/oauth/authorize?${query}` });
    const location = new URL(response.headers.location as string);

    // Performs assertions.
    expect(location.searchParams.get("error")).toBe("invalid_target");
    expect(location.searchParams.get("iss")).toBe(BASE);
    expect(location.searchParams.get("state")).toBe("xyz");
  });

  it("re-renders the page on a wrong password without issuing a code", async () => {
    // Performs the test.
    const response = await form(
      "/oauth/authorize",
      consentFields({ password: "otra contraseña larga" }),
    );

    // Performs assertions.
    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Correo o contraseña incorrectos");
    expect(response.headers.location).toBeUndefined();
  });

  it("returns access_denied when the person rejects", async () => {
    // Performs the test.
    const response = await form("/oauth/authorize", consentFields({ decision: "deny" }));
    const location = new URL(response.headers.location as string);

    // Performs assertions.
    expect(location.searchParams.get("error")).toBe("access_denied");
    expect(location.searchParams.get("code")).toBeNull();
  });

  it("issues tokens that open /mcp after consent and PKCE", async () => {
    // Performs the test.
    const tokens = await obtainTokens();
    const tools = await listTools(tokens.access_token);

    // Performs assertions.
    expect(tokens).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(tools.statusCode).toBe(200);
    expect(tools.json().result.tools.map((tool: { name: string }) => tool.name)).toContain(
      "run_capability",
    );
  });

  it("answers the same invalid_grant for a wrong verifier and a reused code", async () => {
    // Performs the test.
    const consent = await form("/oauth/authorize", consentFields());
    const code = new URL(consent.headers.location as string).searchParams.get("code") ?? "";
    const exchange = (verifier: string) =>
      form("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      });
    const wrong = await exchange(`${VERIFIER}x`);
    const reused = await exchange(VERIFIER);

    // Performs assertions.
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json()).toEqual(reused.json());
  });

  it("rotates the refresh token and revokes the session when an old one comes back", async () => {
    // Performs the test.
    const first = await obtainTokens();
    const refresh = (token: string) =>
      form("/oauth/token", {
        grant_type: "refresh_token",
        refresh_token: token,
        client_id: clientId,
      });
    const second = (await refresh(first.refresh_token)).json();
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

  it("refuses to refresh a session the person revoked", async () => {
    // Performs the test.
    const [role] = await database.db.select().from(roles).where(eq(roles.code, "user"));
    const [beto] = await database.db
      .insert(users)
      .values({
        email: "beto@example.com",
        displayName: "Beto",
        passwordHash: await hashPassword(PASSWORD),
        primaryRoleId: role?.id ?? null,
      })
      .returning({ id: users.id });
    const consent = await form("/oauth/authorize", consentFields({ email: "beto@example.com" }));
    const code = new URL(consent.headers.location as string).searchParams.get("code") ?? "";
    const tokens = (
      await form("/oauth/token", {
        grant_type: "authorization_code",
        code,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: VERIFIER,
      })
    ).json();
    await database.db
      .update(users)
      .set({ tokensRevokedAt: sql`date_trunc('second', now())` })
      .where(eq(users.id, beto?.id ?? 0));
    const response = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
    });

    // Performs assertions.
    expect(response.json().error).toBe("invalid_grant");
  });

  it("refuses a refresh from another client", async () => {
    // Performs the test.
    const tokens = await obtainTokens();
    const response = await form("/oauth/token", {
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: "mcp_other",
    });

    // Performs assertions.
    expect(response.json().error).toBe("invalid_grant");
  });

  it("revokes a token and answers 200 even for an unknown one", async () => {
    // Performs the test.
    const tokens = await obtainTokens();
    const revoked = await form("/oauth/revoke", { token: tokens.refresh_token });
    const unknown = await form("/oauth/revoke", { token: "asr_unknown" });
    const tools = await listTools(tokens.access_token);
    const rows = await database.db
      .select({ revokedAt: accessTokens.revokedAt })
      .from(accessTokens)
      .where(eq(accessTokens.refreshTokenHash, hashToken(tokens.refresh_token)));

    // Performs assertions.
    expect(revoked.statusCode).toBe(200);
    expect(unknown.statusCode).toBe(200);
    expect(tools.statusCode).toBe(401);
    expect(rows[0]?.revokedAt).not.toBeNull();
  });
});

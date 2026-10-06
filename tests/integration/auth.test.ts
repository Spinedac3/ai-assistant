import { createSecretKey } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { ExternalSystem } from "../../src/auth/externalSystems.js";
import { hashPassword } from "../../src/auth/password.js";
import { createTokenSigner } from "../../src/auth/tokens.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { auditLogs, roles, userIdentities, users } from "../../src/db/schema.js";
import { rsaKeys } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const PASSWORD = "tres caballos verdes";
const ISSUER = "ai-assistant-test";
const erpKey = createSecretKey("a-shared-secret-of-enough-length-for-hs256", "utf8");
const keys = rsaKeys();

const systems = new Map<string, ExternalSystem>([
  ["erp", { code: "erp", algorithm: "HS256", key: erpKey, autoProvisionRole: null }],
  ["portal", { code: "portal", algorithm: "HS256", key: erpKey, autoProvisionRole: "user" }],
]);

let database: DatabaseHandle;
let app: FastifyInstance;

/**
 * Creates a user with a password and the given role
 *
 * @param   email  Login email
 * @param   role   Role code
 *
 * @return  The user id
 */
async function createUser(email: string, role = "user"): Promise<number> {
  const [roleRow] = await database.db.select().from(roles).where(eq(roles.code, role));
  const [row] = await database.db
    .insert(users)
    .values({
      email,
      displayName: email,
      passwordHash: await hashPassword(PASSWORD),
      primaryRoleId: roleRow?.id ?? null,
    })
    .returning({ id: users.id });

  return row?.id ?? 0;
}

/**
 * Logs in with a password
 *
 * @param   email     Login email
 * @param   password  Plain password
 *
 * @return  The response
 */
function login(email: string, password = PASSWORD) {
  return app.inject({ method: "POST", url: "/auth/login", payload: { email, password } });
}

/**
 * Signs a login token as an external system
 *
 * @param   iss  System code
 * @param   sub  External id
 *
 * @return  The token
 */
function systemToken(iss: string, sub: string): Promise<string> {
  return new SignJWT({ email: `${sub.toLowerCase()}@example.com`, name: `Persona ${sub}` })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(iss)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(erpKey);
}

describe("auth", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    app = await buildApp({
      db: database.db,
      signer: createTokenSigner(keys.privateKey, ISSUER, 60),
      systems,
    });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("logs in with a password and reads its own identity", async () => {
    // Performs the test.
    await createUser("ana@example.com");
    const response = await login("ANA@example.com");
    const me = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${response.json().data.token}` },
    });

    // Performs assertions.
    expect(response.statusCode).toBe(200);
    expect(me.statusCode).toBe(200);
    expect(me.json().data.email).toBe("ana@example.com");
    expect(me.json().data.scopes).toEqual(["chat.use", "docs.general.read"]);
  });

  it("answers the same for a wrong password and an unknown email", async () => {
    // Performs the test.
    await createUser("beto@example.com");
    const wrong = await login("beto@example.com", "otra contraseña larga");
    const unknown = await login("nadie@example.com");

    // Performs assertions.
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json()).toEqual(unknown.json());
  });

  it("locks the account after five failures, even for the right password", async () => {
    // Performs the test.
    const userId = await createUser("caro@example.com");
    for (let attempt = 0; attempt < 5; attempt++) {
      await login("caro@example.com", "otra contraseña larga");
    }
    const locked = await login("caro@example.com");
    await database.db
      .update(users)
      .set({ lockedUntil: sql`now() - interval '1 second'` })
      .where(eq(users.id, userId));
    const unlocked = await login("caro@example.com");

    // Performs assertions.
    expect(locked.statusCode).toBe(401);
    expect(unlocked.statusCode).toBe(200);
  });

  it("rejects a token issued before the sessions were revoked", async () => {
    // Performs the test.
    await createUser("dani@example.com");
    const token = (await login("dani@example.com")).json().data.token;
    const headers = { authorization: `Bearer ${token}` };
    await app.inject({ method: "POST", url: "/auth/sessions/revoke", headers });
    const after = await app.inject({ method: "GET", url: "/auth/me", headers });

    // Performs assertions.
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toBe("token_revoked");
  });

  it("applies a role change before the token expires", async () => {
    // Performs the test.
    const userId = await createUser("eva@example.com");
    const headers = {
      authorization: `Bearer ${(await login("eva@example.com")).json().data.token}`,
    };
    const [adminRole] = await database.db.select().from(roles).where(eq(roles.code, "admin"));
    await database.db
      .update(users)
      .set({ primaryRoleId: adminRole?.id ?? null })
      .where(eq(users.id, userId));
    const me = await app.inject({ method: "GET", url: "/auth/me", headers });

    // Performs assertions.
    expect(me.json().data.role).toBe("admin");
    expect([...me.json().data.scopes].sort()).toEqual([
      "chat.use",
      "docs.general.read",
      "docs.manage",
      "notices.send",
      "settings.manage",
      "sources.manage",
      "tools.manage",
      "usage.read",
      "users.manage",
    ]);
  });

  it("renews a token that entered the last third of its life", async () => {
    // Performs the test.
    const userId = await createUser("fede@example.com");
    const shortLived = await createTokenSigner(keys.privateKey, ISSUER, 10).sign({
      sub: userId,
      role: "user",
      scopes: ["chat.use"],
      email: "fede@example.com",
    });
    const fresh = (await login("fede@example.com")).json().data.token;
    const renewed = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${shortLived}` },
    });
    const notRenewed = await app.inject({
      method: "GET",
      url: "/auth/me",
      headers: { authorization: `Bearer ${fresh}` },
    });

    // Performs assertions.
    expect(renewed.headers["x-renewed-token"]).toEqual(expect.any(String));
    expect(notRenewed.headers["x-renewed-token"]).toBeUndefined();
  });

  it("provisions a user on the first system login and reuses it after", async () => {
    // Performs the test.
    const first = await app.inject({
      method: "POST",
      url: "/auth/system-login",
      payload: { token: await systemToken("portal", "P-1") },
    });
    const second = await app.inject({
      method: "POST",
      url: "/auth/system-login",
      payload: { token: await systemToken("portal", "P-1") },
    });
    const identities = await database.db
      .select()
      .from(userIdentities)
      .where(eq(userIdentities.externalId, "P-1"));

    // Performs assertions.
    expect(first.statusCode).toBe(200);
    expect(first.json().data.user.role).toBe("user");
    expect(second.json().data.user.id).toBe(first.json().data.user.id);
    expect(identities).toHaveLength(1);
  });

  it("drops a password set before the person first came through a system, and its sessions", async () => {
    await createUser("p-2@example.com");
    const before = (await login("p-2@example.com")).json().data.token;
    // A session issued earlier than the link, as one set up by someone else would be
    await database.db.execute(sql`select pg_sleep(1.1)`);

    // Performs the test.
    const linked = await app.inject({
      method: "POST",
      url: "/auth/system-login",
      payload: { token: await systemToken("portal", "P-2") },
    });
    const byPassword = await login("p-2@example.com");
    const oldSession = await app.inject({
      url: "/auth/me",
      headers: { authorization: `Bearer ${before}` },
    });
    const newSession = await app.inject({
      url: "/auth/me",
      headers: { authorization: `Bearer ${linked.json().data.token}` },
    });

    // Performs assertions.
    expect(linked.statusCode).toBe(200);
    expect(byPassword.statusCode).toBe(401);
    expect(oldSession.statusCode).toBe(401);
    expect(newSession.statusCode).toBe(200);
  });

  it("refuses an unknown identity of a system without provisioning", async () => {
    // Performs the test.
    const response = await app.inject({
      method: "POST",
      url: "/auth/system-login",
      payload: { token: await systemToken("erp", "E-9") },
    });
    const [audit] = await database.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.eventCode, "auth.unknown_identity"));

    // Performs assertions.
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("unknown_identity");
    expect(audit?.systemCode).toBe("erp");
  });
});

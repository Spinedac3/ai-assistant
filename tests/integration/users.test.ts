import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { auditLogs, roles, scopes, userIdentities, users } from "../../src/db/schema.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const PASSWORD = "tres caballos verdes";
// One the API accepts when it sets a password itself
const STRONG = "lámpara roja junto al río 47";

let database: DatabaseHandle;
let app: FastifyInstance;
const ids: Record<string, number> = {};
const tokens: Record<string, string> = {};

/**
 * Calls the app as one of the people
 *
 * @param   who     Person
 * @param   method  HTTP method
 * @param   url     Path
 * @param   body    JSON body
 *
 * @return  Status and body
 */
async function as(
  who: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  url: string,
  body?: object,
) {
  const response = await app.inject({
    method,
    url,
    headers: { authorization: `Bearer ${tokens[who]}` },
    ...(body ? { payload: body } : {}),
  });

  return { status: response.statusCode, body: response.json() };
}

/**
 * Logs a person in
 *
 * @param   email     Login email
 * @param   password  Plain password
 *
 * @return  The token
 */
async function login(email: string, password = PASSWORD): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password },
  });
  return response.json().data.token;
}

describe("users, roles and permissions", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    app = await buildApp({ db: database.db, signer: testSigner(), systems: new Map() });
    const roleIds = Object.fromEntries(
      (await database.db.select({ id: roles.id, code: roles.code }).from(roles)).map((row) => [
        row.code,
        row.id,
      ]),
    );
    for (const [key, role] of [
      ["ana", "admin"],
      ["beto", "user"],
    ] as const) {
      const [row] = await database.db
        .insert(users)
        .values({
          email: `${key}@example.com`,
          displayName: key,
          passwordHash: await hashPassword(PASSWORD),
          primaryRoleId: roleIds[role],
        })
        .returning({ id: users.id });
      ids[key] = row?.id ?? 0;
      tokens[key] = await login(`${key}@example.com`);
    }
    await database.db
      .insert(userIdentities)
      .values({ userId: ids.beto ?? 0, systemCode: "erp", externalId: "B1" });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("creates accounts with a known role, a sound password or none, and never twice for one address", async () => {
    // Performs the test.
    const weak = await as("ana", "POST", "/admin/users", {
      email: "c@example.com",
      displayName: "C",
      role: "user",
      password: "corta",
    });
    const noRole = await as("ana", "POST", "/admin/users", {
      email: "c@example.com",
      displayName: "C",
      role: "jefe",
    });
    const created = await as("ana", "POST", "/admin/users", {
      email: "Carla@Example.com",
      displayName: "Carla",
      role: "user",
    });
    const again = await as("ana", "POST", "/admin/users", {
      email: "carla@example.com",
      displayName: "Otra",
      role: "user",
    });
    const badEmail = await as("ana", "POST", "/admin/users", {
      email: "no-es-correo",
      displayName: "C",
      role: "user",
    });
    const denied = await as("beto", "POST", "/admin/users", {
      email: "d@example.com",
      displayName: "D",
      role: "user",
    });
    const listed = await as("ana", "GET", "/admin/users");
    ids.carla = created.body.data.id;

    // Performs assertions.
    expect(badEmail.body).toMatchObject({ message: "Revisa el correo" });
    expect(weak.body).toMatchObject({ error: "weak_password" });
    expect(noRole.body).toMatchObject({ error: "unknown_role" });
    expect(created.status).toBe(201);
    expect(again.body).toMatchObject({ error: "email_taken" });
    expect(denied.status).toBe(403);
    expect(listed.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          email: "carla@example.com",
          role: "user",
          hasPassword: false,
          active: true,
        }),
        expect.objectContaining({ email: "beto@example.com", systems: ["erp"], hasPassword: true }),
      ]),
    );
  });

  it("never lets the person acting lock themselves out, and switching someone off ends their sessions", async () => {
    // Performs the test.
    const selfOff = await as("ana", "PATCH", `/admin/users/${ids.ana}`, { active: false });
    const selfDemoted = await as("ana", "PATCH", `/admin/users/${ids.ana}`, { role: "user" });
    const selfDeleted = await as("ana", "DELETE", `/admin/users/${ids.ana}`);
    const renamed = await as("ana", "PATCH", `/admin/users/${ids.beto}`, {
      displayName: "Beto Ruiz",
    });
    const off = await as("ana", "PATCH", `/admin/users/${ids.beto}`, { active: false });
    const betoAfter = await as("beto", "GET", "/auth/me");
    await as("ana", "PATCH", `/admin/users/${ids.beto}`, { active: true });
    const [beto] = await database.db
      .select()
      .from(users)
      .where(eq(users.id, ids.beto ?? 0));

    // Performs assertions.
    expect(selfOff.body).toMatchObject({ error: "locked_out" });
    expect(selfDemoted.body).toMatchObject({ error: "locked_out" });
    expect(selfDeleted.body).toMatchObject({ error: "locked_out" });
    expect(renamed.status).toBe(200);
    expect(off.status).toBe(200);
    expect(betoAfter.status).toBe(401);
    expect(beto).toMatchObject({ displayName: "Beto Ruiz", active: true });
  });

  it("grants extra permissions with a reason and an end, and takes them back unless that locks someone out", async () => {
    // Performs the test.
    const noReason = await as("ana", "PUT", `/admin/users/${ids.beto}/scopes/usage.read`, {});
    const past = await as("ana", "PUT", `/admin/users/${ids.beto}/scopes/usage.read`, {
      reason: "x",
      expiresAt: "2020-01-01T00:00:00Z",
    });
    const notHeld = await as("ana", "DELETE", `/admin/users/${ids.beto}/scopes/settings.manage`);
    const unknown = await as("ana", "PUT", `/admin/users/${ids.beto}/scopes/no.existe`, {
      reason: "x",
    });
    const granted = await as("ana", "PUT", `/admin/users/${ids.beto}/scopes/usage.read`, {
      reason: "Revisa el uso del mes",
      expiresAt: "2099-01-01T00:00:00Z",
    });
    // Beto may now manage users, and on his own he cannot give that up
    await as("ana", "PUT", `/admin/users/${ids.beto}/scopes/users.manage`, { reason: "Suplencia" });
    // Out of the second his sessions were revoked in, or the new one is born revoked
    await database.db.execute(sql`select pg_sleep(1.1)`);
    tokens.beto = await login("beto@example.com");
    const selfRevoked = await as("beto", "DELETE", `/admin/users/${ids.beto}/scopes/users.manage`);
    const revoked = await as("ana", "DELETE", `/admin/users/${ids.beto}/scopes/users.manage`);
    const listed = await as("ana", "GET", "/admin/users");
    const extras = listed.body.data.find(
      (person: { id: number }) => person.id === ids.beto,
    ).extraScopes;

    // Performs assertions.
    expect(noReason.status).toBe(400);
    expect(past.body).toMatchObject({ error: "invalid_body" });
    expect(notHeld.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(granted.status).toBe(200);
    expect(selfRevoked.body).toMatchObject({ error: "locked_out" });
    expect(revoked.status).toBe(200);
    expect(extras).toEqual([
      {
        code: "usage.read",
        expiresAt: expect.stringContaining("2099-01-01"),
        reason: "Revisa el uso del mes",
        expired: false,
      },
    ]);
  });

  it("makes roles from existing scopes, keeps the admin role whole, and opens areas of documents", async () => {
    // Performs the test.
    const unknownScope = await as("ana", "POST", "/admin/roles", {
      code: "jefes",
      description: "Jefes",
      scopes: ["chat.use", "nada"],
    });
    const made = await as("ana", "POST", "/admin/roles", {
      code: "jefes",
      description: "Jefes",
      scopes: ["chat.use"],
    });
    const twice = await as("ana", "POST", "/admin/roles", {
      code: "jefes",
      description: "Jefes",
      scopes: [],
    });
    const trimmed = await as("ana", "PUT", "/admin/roles/admin", { scopes: ["chat.use"] });
    const switchedOff = await as("ana", "PUT", "/admin/roles/admin", { active: false });
    const described = await as("ana", "PUT", "/admin/roles/admin", { description: "Todo" });
    const area = await as("ana", "POST", "/admin/scopes", {
      area: "rrhh",
      description: "Leer RRHH",
    });
    const areaTwice = await as("ana", "POST", "/admin/scopes", {
      area: "rrhh",
      description: "Otra",
    });
    const badArea = await as("ana", "POST", "/admin/scopes", {
      area: "RRHH ventas",
      description: "x",
    });
    const edited = await as("ana", "PUT", "/admin/roles/jefes", {
      scopes: ["chat.use", "docs.rrhh.read"],
    });
    const listed = await as("ana", "GET", "/admin/roles");
    const jefes = listed.body.data.find((role: { code: string }) => role.code === "jefes");
    const admin = listed.body.data.find((role: { code: string }) => role.code === "admin");

    // Performs assertions.
    expect(unknownScope.body).toMatchObject({ error: "unknown_scope" });
    expect(made.status).toBe(201);
    expect(twice.body).toMatchObject({ error: "role_taken" });
    expect(trimmed.body).toMatchObject({ error: "role_protected" });
    expect(switchedOff.body).toMatchObject({ error: "role_protected" });
    expect(described.status).toBe(200);
    expect(area.body).toMatchObject({ data: { code: "docs.rrhh.read" } });
    expect(areaTwice.body).toMatchObject({ error: "scope_taken" });
    expect(badArea.status).toBe(400);
    expect(edited.status).toBe(200);
    expect(jefes).toMatchObject({
      scopes: ["chat.use", "docs.rrhh.read"],
      people: 0,
      protected: false,
    });
    expect(admin).toMatchObject({ protected: true, people: 1 });
    expect(admin.scopes).toContain("docs.rrhh.read");
  });

  it("deletes an account softly and leaves every change on record", async () => {
    // Performs the test.
    const deleted = await as("ana", "DELETE", `/admin/users/${ids.carla}`);
    const again = await as("ana", "DELETE", `/admin/users/${ids.carla}`);
    const listed = await as("ana", "GET", "/admin/users");
    const [stored] = await database.db
      .select()
      .from(users)
      .where(eq(users.id, ids.carla ?? 0));
    const codes = (await database.db.select({ code: auditLogs.eventCode }).from(auditLogs)).map(
      (row) => row.code,
    );
    const [area] = await database.db.select().from(scopes).where(eq(scopes.code, "docs.rrhh.read"));

    // Performs assertions.
    expect(deleted.status).toBe(200);
    expect(again.status).toBe(404);
    expect(listed.body.data.map((person: { id: number }) => person.id)).not.toContain(ids.carla);
    expect(stored?.deletedAt).not.toBeNull();
    expect(area).toBeDefined();
    expect(codes).toEqual(
      expect.arrayContaining([
        "users.created",
        "users.changed",
        "users.deleted",
        "users.scope_granted",
        "users.scope_revoked",
        "roles.created",
        "roles.changed",
        "scopes.created",
      ]),
    );
  });

  it("never hands out more than the person acting holds, nor strips someone who holds more", async () => {
    await as("ana", "POST", "/admin/roles", {
      code: "gestores",
      description: "Gestionan cuentas",
      scopes: ["chat.use", "users.manage"],
    });
    for (const key of ["dani", "fran"]) {
      const created = await as("ana", "POST", "/admin/users", {
        email: `${key}@example.com`,
        displayName: key,
        role: "gestores",
        password: STRONG,
      });
      ids[key] = created.body.data.id;
      tokens[key] = await login(`${key}@example.com`, STRONG);
    }

    // Performs the test.
    const toAdmin = await as("dani", "PATCH", `/admin/users/${ids.dani}`, { role: "admin" });
    const createdAdmin = await as("dani", "POST", "/admin/users", {
      email: "gina@example.com",
      displayName: "Gina",
      role: "admin",
    });
    const extra = await as("dani", "PUT", `/admin/users/${ids.dani}/scopes/settings.manage`, {
      reason: "x",
    });
    const stripAdmin = await as("dani", "DELETE", `/admin/users/${ids.ana}`);
    const offAdmin = await as("dani", "PATCH", `/admin/users/${ids.ana}`, { active: false });
    const widened = await as("dani", "PUT", "/admin/roles/gestores", {
      scopes: ["chat.use", "users.manage", "settings.manage"],
    });
    const madeRole = await as("dani", "POST", "/admin/roles", {
      code: "todo",
      description: "x",
      scopes: ["settings.manage"],
    });
    const ownRoleOff = await as("dani", "PUT", "/admin/roles/gestores", { active: false });
    const ownRoleTrimmed = await as("dani", "PUT", "/admin/roles/gestores", {
      scopes: ["chat.use"],
    });
    const lesser = await as("dani", "PUT", `/admin/users/${ids.beto}/scopes/chat.use`, {
      reason: "Apoyo",
    });
    // Two managers switching each other off at once: only one change may win
    const both = await Promise.all([
      as("dani", "PATCH", `/admin/users/${ids.fran}`, { active: false }),
      as("fran", "PATCH", `/admin/users/${ids.dani}`, { active: false }),
    ]);

    // Performs assertions.
    for (const refused of [toAdmin, createdAdmin, extra, stripAdmin, offAdmin, widened, madeRole]) {
      expect(refused.body).toMatchObject({ error: "beyond_own_scopes" });
    }
    expect(ownRoleOff.body).toMatchObject({ error: "locked_out" });
    expect(ownRoleTrimmed.body).toMatchObject({ error: "locked_out" });
    expect(lesser.status).toBe(200);
    // The loser is refused as locked out, or as already switched off if it arrived after
    expect(both.filter((response) => response.status === 200)).toHaveLength(1);
  });

  it("shows a switched-off role as none and an expired extra as expired", async () => {
    await as("ana", "PUT", `/admin/users/${ids.beto}/scopes/usage.read`, { reason: "Mes" });
    await database.db.execute(
      sql`update user_extra_scopes set expires_at = now() - interval '1 day' where user_id = ${ids.beto}`,
    );
    await as("ana", "PATCH", `/admin/users/${ids.beto}`, { role: "jefes" });
    await as("ana", "PUT", "/admin/roles/jefes", { active: false });

    // Performs the test.
    const listed = await as("ana", "GET", "/admin/users");
    const renamed = await as("ana", "PATCH", `/admin/users/${ids.beto}`, { displayName: "Beto" });
    const beto = listed.body.data.find((person: { id: number }) => person.id === ids.beto);

    // Performs assertions.
    expect(beto.role).toBeNull();
    expect(beto.extraScopes).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "usage.read", expired: true })]),
    );
    expect(renamed.status).toBe(200);
  });
});

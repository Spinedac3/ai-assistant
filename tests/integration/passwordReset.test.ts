import { randomBytes } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { passwordResets, roles, users } from "../../src/db/schema.js";
import { smtpMailer } from "../../src/notices/mailer.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";
import { MAILPIT_SMTP, mailsTo } from "./support/mailpit.js";

const PASSWORD = "tres caballos verdes";
const NEW_PASSWORD = "cuatro jirafas moradas";
// Mailpit keeps what earlier runs caught, so every run writes to addresses of its own
const run = randomBytes(4).toString("hex");
const ana = `ana-${run}@example.com`;

let database: DatabaseHandle;
let app: FastifyInstance;
let quiet: FastifyInstance;
let adminToken: string;
let anaId: number;

/**
 * Creates a user with a password and a role
 *
 * @param   email   Login email
 * @param   role    Role code
 * @param   active  Whether the account may log in
 *
 * @return  The user id
 */
async function createUser(email: string, role: string, active = true): Promise<number> {
  const [roleRow] = await database.db.select().from(roles).where(eq(roles.code, role));
  const [row] = await database.db
    .insert(users)
    .values({
      email,
      displayName: "Ana Ruiz",
      passwordHash: await hashPassword(PASSWORD),
      primaryRoleId: roleRow?.id ?? null,
      active,
    })
    .returning({ id: users.id });

  return row?.id ?? 0;
}

/**
 * Logs in and returns the access token
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
 * Asks for a reset link for an account
 *
 * @param   id      Account id
 * @param   token   Access token of who asks
 * @param   target  App that answers
 *
 * @return  The response
 */
function sendLink(id: number, token = adminToken, target = app) {
  return target.inject({
    method: "POST",
    url: `/admin/users/${id}/password-reset`,
    headers: { authorization: `Bearer ${token}` },
  });
}

/**
 * Sets a new password with a link token
 *
 * @param   token     Token of the link
 * @param   password  New password
 *
 * @return  The response
 */
function reset(token: string, password = NEW_PASSWORD) {
  return app.inject({ method: "POST", url: "/auth/password-reset", payload: { token, password } });
}

/**
 * Reads the token of the newest link mailed to an address
 *
 * @param   to  Address
 *
 * @return  The token
 */
async function lastLinkToken(to: string): Promise<string> {
  const mails = await mailsTo(to);
  return mails.at(-1)?.text.match(/reset-password#token=(\S+)/)?.[1] ?? "";
}

describe("password reset by mail", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    const deps = { db: database.db, signer: testSigner(), systems: new Map() };
    app = await buildApp({
      ...deps,
      passwordReset: {
        mailer: smtpMailer(MAILPIT_SMTP),
        publicBaseUrl: "https://assistant.example.com",
        assistantName: "Lumen",
      },
    });
    quiet = await buildApp({
      ...deps,
      passwordReset: { mailer: null, publicBaseUrl: "https://x.example.com", assistantName: "x" },
    });
    await createUser(`admin-${run}@example.com`, "admin");
    anaId = await createUser(ana, "user");
    adminToken = (await login(`admin-${run}@example.com`)).json().data.token;
  });

  afterAll(async () => {
    await app.close();
    await quiet.close();
    await database.close();
  });

  it("mails a one-time link that sets a new password and logs out the old sessions", async () => {
    // Performs the test.
    const before = (await login(ana)).json().data.token;
    const sent = await sendLink(anaId);
    const mail = (await mailsTo(ana)).at(-1);
    const token = await lastLinkToken(ana);
    const weak = await reset(token, "corta");
    const done = await reset(token);
    const again = await reset(token, "otra clave bastante larga");
    const oldSession = await app.inject({
      url: "/auth/me",
      headers: { authorization: `Bearer ${before}` },
    });

    // Performs assertions.
    expect(sent.json()).toEqual({ ok: true });
    expect(mail?.subject).toBe("Nueva contraseña para Lumen");
    expect(mail?.text).toContain("https://assistant.example.com/reset-password#token=asp_");
    expect(weak.json()).toMatchObject({ error: "weak_password" });
    expect(done.json()).toEqual({ ok: true });
    expect(again.json()).toMatchObject({ error: "invalid_link" });
    expect(oldSession.statusCode).toBe(401);
    expect((await login(ana, NEW_PASSWORD)).statusCode).toBe(200);
    expect((await login(ana)).statusCode).toBe(401);
  });

  it("keeps only the newest link alive, and never an expired one", async () => {
    // Performs the test.
    await sendLink(anaId);
    const first = await lastLinkToken(ana);
    await sendLink(anaId);
    const second = await lastLinkToken(ana);
    await database.db
      .update(passwordResets)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(passwordResets.userId, anaId));
    const replaced = await reset(first);
    const expired = await reset(second);

    // Performs assertions.
    expect(first).not.toBe(second);
    expect(replaced.json()).toMatchObject({ error: "invalid_link" });
    expect(expired.json()).toMatchObject({ error: "invalid_link" });
  });

  it("is only for whoever manages users, to an active account, with a mail server", async () => {
    // Performs the test.
    await createUser(`beto-${run}@example.com`, "user");
    const betoToken = (await login(`beto-${run}@example.com`)).json().data.token;
    const inactive = await createUser(`ida-${run}@example.com`, "user", false);
    const notAllowed = await sendLink(anaId, betoToken);
    const toInactive = await sendLink(inactive);
    const noMail = await sendLink(anaId, adminToken, quiet);

    // Performs assertions.
    expect(notAllowed.statusCode).toBe(403);
    expect(toInactive.statusCode).toBe(404);
    expect(noMail.json()).toMatchObject({ error: "mail_off" });
    expect(await mailsTo(`ida-${run}@example.com`)).toEqual([]);
  });
});

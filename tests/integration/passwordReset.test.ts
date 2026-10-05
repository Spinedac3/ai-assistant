import { randomBytes } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
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
let failing: FastifyInstance;
let racing: FastifyInstance;
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
    failing = await buildApp({
      ...deps,
      passwordReset: {
        mailer: async () => {
          throw new Error("421 servicio no disponible");
        },
        publicBaseUrl: "https://assistant.example.com",
        assistantName: "Lumen",
      },
    });
    // While its mail goes out, another send for the same person stores a newer link
    racing = await buildApp({
      ...deps,
      passwordReset: {
        mailer: async () => {
          await database.db.insert(passwordResets).values({
            userId: anaId,
            tokenHash: "c".repeat(64),
            expiresAt: sql`now() + interval '1 hour'`,
            createdBy: anaId,
          });
        },
        publicBaseUrl: "https://assistant.example.com",
        assistantName: "Lumen",
      },
    });
    await createUser(`admin-${run}@example.com`, "admin");
    anaId = await createUser(ana, "user");
    adminToken = (await login(`admin-${run}@example.com`)).json().data.token;
  });

  afterAll(async () => {
    await app.close();
    await quiet.close();
    await failing.close();
    await racing.close();
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
    expect((await login(ana)).statusCode).toBe(401);
    // The session opened right after the reset is not born revoked
    const after = (await login(ana, NEW_PASSWORD)).json().data.token;
    const newSession = await app.inject({
      url: "/auth/me",
      headers: { authorization: `Bearer ${after}` },
    });
    expect(newSession.statusCode).toBe(200);
  });

  it("keeps only the newest link alive, never an expired one, and keeps the old one when the new one fails", async () => {
    // Performs the test.
    await sendLink(anaId);
    const first = await lastLinkToken(ana);
    await sendLink(anaId);
    const second = await lastLinkToken(ana);
    const replaced = await reset(first);
    const failedSend = await sendLink(anaId, adminToken, failing);
    // The link that never went out is not left behind
    const alive = await database.db
      .select({ id: passwordResets.id })
      .from(passwordResets)
      .where(and(eq(passwordResets.userId, anaId), isNull(passwordResets.usedAt)));
    // The link the person already had still works
    const kept = await reset(second);
    await sendLink(anaId);
    const third = await lastLinkToken(ana);
    await database.db
      .update(passwordResets)
      .set({ expiresAt: sql`now() - interval '1 minute'` })
      .where(eq(passwordResets.userId, anaId));
    const expired = await reset(third);

    // Performs assertions.
    expect(first).not.toBe(second);
    expect(replaced.json()).toMatchObject({ error: "invalid_link" });
    expect(failedSend.json()).toMatchObject({ error: "mail_failed" });
    expect(alive).toHaveLength(1);
    expect(kept.json()).toEqual({ ok: true });
    expect(expired.json()).toMatchObject({ error: "invalid_link" });
  });

  it("lets a link set one password even when used twice at once, and never cancels a newer send", async () => {
    // Performs the test.
    await sendLink(anaId);
    const token = await lastLinkToken(ana);
    const both = await Promise.all([reset(token), reset(token)]);
    await sendLink(anaId, adminToken, racing);
    const newer = await database.db
      .select({ id: passwordResets.id })
      .from(passwordResets)
      .where(and(eq(passwordResets.tokenHash, "c".repeat(64)), isNull(passwordResets.usedAt)));

    // Performs assertions.
    expect(both.map((response) => response.json().ok ?? false).sort()).toEqual([false, true]);
    expect(newer).toHaveLength(1);
  });

  it("opens a page that reads the link and runs only its own script", async () => {
    // Performs the test.
    const page = await app.inject({ url: "/reset-password" });
    const nonce = page.headers["content-security-policy"]?.toString().match(/'nonce-([^']+)'/)?.[1];

    // Performs assertions.
    expect(page.statusCode).toBe(200);
    expect(page.headers["content-type"]).toContain("text/html");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(nonce).toBeTruthy();
    expect(page.body).toContain(`<script nonce="${nonce}">`);
    // Relative to /reset-password, so it reaches /auth/password-reset under any published path
    expect(page.body).toContain('fetch("auth/password-reset"');
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.body).toContain("Este enlace no sirve");
    expect(page.body).toContain("Nueva contraseña para Lumen");
  });

  it("is only for whoever manages users, to an active account, with a mail server", async () => {
    // Performs the test.
    await createUser(`beto-${run}@example.com`, "user");
    const betoToken = (await login(`beto-${run}@example.com`)).json().data.token;
    const inactive = await createUser(`ida-${run}@example.com`, "user", false);
    const deleted = await createUser(`eli-${run}@example.com`, "user");
    await database.db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, deleted));
    const [external] = await database.db
      .insert(users)
      .values({ email: `sso-${run}@example.com`, displayName: "Por SSO" })
      .returning({ id: users.id });
    const notAllowed = await sendLink(anaId, betoToken);
    const toInactive = await sendLink(inactive);
    const toDeleted = await sendLink(deleted);
    const toExternal = await sendLink(external?.id ?? 0);
    const noMail = await sendLink(anaId, adminToken, quiet);

    // Performs assertions.
    expect(notAllowed.statusCode).toBe(403);
    expect(toInactive.statusCode).toBe(404);
    expect(toDeleted.statusCode).toBe(404);
    expect(toExternal.json()).toMatchObject({ error: "external_account" });
    expect(await mailsTo(`sso-${run}@example.com`)).toEqual([]);
    expect(noMail.json()).toMatchObject({ error: "mail_off" });
    expect(await mailsTo(`ida-${run}@example.com`)).toEqual([]);
  });
});

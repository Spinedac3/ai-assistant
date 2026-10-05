import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import { generateToken, hashToken } from "../auth/opaqueTokens.js";
import { hashPassword, passwordProblem } from "../auth/password.js";
import type { Database } from "../db/client.js";
import { passwordResets, users } from "../db/schema.js";
import type { SendMail } from "../notices/mailer.js";

export interface PasswordResetRoutesOptions {
  db: Database;
  // Without a mail server there is no way to send the link
  mailer: SendMail | null;
  publicBaseUrl: string;
  assistantName: string;
}

// Long enough to read the mail, short enough that a forgotten one is useless soon
const LINK_MINUTES = 60;

const userParams = z.object({ id: z.coerce.number().int().positive() });
const resetBody = z.object({
  token: z.string().min(1).max(100),
  password: z.string().min(1).max(1_000),
});

/**
 * Registers the reset of a password by mail: an administrator sends a one-time link and the person
 * sets a new password with it
 *
 * @param   app      Fastify instance
 * @param   options  Database, mail sender and the address the link points to
 */
export default async function passwordResetRoutes(
  app: FastifyInstance,
  options: PasswordResetRoutesOptions,
): Promise<void> {
  const { db } = options;
  const guard = { preHandler: [app.requireAuth, app.requireScope("users.manage")] };

  app.post("/admin/users/:id/password-reset", guard, async (request, reply) => {
    const params = userParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ ok: false, error: "invalid_id" });
    }
    if (!options.mailer) {
      return reply
        .code(503)
        .send({ ok: false, error: "mail_off", message: "No hay servidor de correo configurado" });
    }
    const [user] = await db
      .select({ id: users.id, email: users.email, name: users.displayName })
      .from(users)
      .where(and(eq(users.id, params.data.id), eq(users.active, true)));
    if (!user) {
      return reply.code(404).send({ ok: false, error: "user_not_found" });
    }

    // Only the newest link works, so a mail sent by mistake is undone by sending another
    await db
      .delete(passwordResets)
      .where(and(eq(passwordResets.userId, user.id), isNull(passwordResets.usedAt)));
    const token = generateToken("asp");
    await db.insert(passwordResets).values({
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + LINK_MINUTES * 60_000),
      createdBy: request.authUser?.id ?? 0,
    });

    try {
      // In the fragment, the token never reaches a server log or a Referer header
      await options.mailer({
        to: user.email,
        subject: `Nueva contraseña para ${options.assistantName}`,
        text:
          `Hola, ${user.name}:\n\nPara poner una contraseña nueva abre este enlace. Sirve una sola ` +
          `vez y vence en ${LINK_MINUTES} minutos:\n\n${options.publicBaseUrl}/reset-password#token=${token}\n\n` +
          "Si no lo pediste, ignora este correo; tu contraseña actual sigue igual.",
      });
    } catch (error) {
      request.log.warn({ err: error }, "password reset mail failed");
      return reply.code(502).send({
        ok: false,
        error: "mail_failed",
        message: "No se pudo enviar el correo; vuelve a intentarlo",
      });
    }

    await logAudit(db, {
      userId: request.authUser?.id ?? null,
      level: "info",
      eventCode: "auth.password_reset_sent",
      message: `Enlace para nueva contraseña enviado a la cuenta ${user.id}`,
      ip: request.ip,
    });

    return { ok: true };
  });

  app.post("/auth/password-reset", async (request, reply) => {
    const body = resetBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }
    const invalid = () =>
      reply.code(400).send({
        ok: false,
        error: "invalid_link",
        message: "El enlace no sirve: ya se usó, venció o no existe. Pide uno nuevo",
      });

    const tokenHash = hashToken(body.data.token);
    const [found] = await db
      .select({ userId: users.id, email: users.email, name: users.displayName })
      .from(passwordResets)
      .innerJoin(users, eq(users.id, passwordResets.userId))
      .where(
        and(
          eq(passwordResets.tokenHash, tokenHash),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, sql`now()`),
          eq(users.active, true),
        ),
      );
    if (!found) {
      return invalid();
    }

    // Checked before the link is spent, so a weak password does not cost the person a new mail
    const problem = passwordProblem(body.data.password, [found.email, found.name]);
    if (problem) {
      return reply.code(400).send({ ok: false, error: "weak_password", message: problem });
    }

    // Spending the link is the single atomic step: two requests with it cannot both pass
    const spent = await db
      .update(passwordResets)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(passwordResets.tokenHash, tokenHash),
          isNull(passwordResets.usedAt),
          gt(passwordResets.expiresAt, sql`now()`),
        ),
      )
      .returning({ id: passwordResets.id });
    if (spent.length === 0) {
      return invalid();
    }

    // Whoever held the account before the reset is logged out
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(body.data.password),
        failedLogins: 0,
        lockedUntil: null,
        // Whole seconds, as the sessions revoke stores it
        tokensRevokedAt: sql`date_trunc('second', now())`,
      })
      .where(eq(users.id, found.userId));
    await logAudit(db, {
      userId: found.userId,
      level: "info",
      eventCode: "auth.password_reset_done",
      message: "Contraseña nueva puesta con el enlace",
      ip: request.ip,
    });

    return { ok: true };
  });
}

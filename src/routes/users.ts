import { and, asc, count, eq, inArray, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import { hashPassword, passwordProblem } from "../auth/password.js";
import type { Database } from "../db/client.js";
import { roleScopes, roles, scopes, userExtraScopes, userIdentities, users } from "../db/schema.js";
import { resolveUser } from "../permissions/resolve.js";

export interface UsersRoutesOptions {
  db: Database;
}

// The scope that lets someone manage everyone else; there is always someone holding it
const MANAGE = "users.manage";
// The role that holds every scope, now and as new ones appear
const ADMIN_ROLE = "admin";
const AREA = /^[a-z0-9_-]{1,40}$/;

const idParams = z.object({ id: z.coerce.number().int().positive() });
const userBody = z
  .object({
    email: z.string().trim().toLowerCase().pipe(z.email().max(255)),
    displayName: z.string().trim().min(1).max(255),
    role: z.string().min(1).max(50),
    password: z.string().min(1).max(1_000).optional(),
  })
  .strict();
const userChange = z
  .object({
    displayName: z.string().trim().min(1).max(255).optional(),
    role: z.string().min(1).max(50).optional(),
    active: z.boolean().optional(),
  })
  .strict();
const grantParams = z.object({
  id: z.coerce.number().int().positive(),
  code: z.string().min(1).max(100),
});
const grantBody = z
  .object({
    expiresAt: z.iso.datetime({ offset: true }).nullable().optional(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict();
const roleBody = z
  .object({
    code: z.string().regex(/^[a-z][a-z0-9_-]{1,49}$/, "minúsculas, números, guion y guion bajo"),
    description: z.string().trim().min(1).max(255),
    scopes: z.array(z.string().min(1).max(100)).max(500),
  })
  .strict();
const roleChange = z
  .object({
    description: z.string().trim().min(1).max(255).optional(),
    active: z.boolean().optional(),
    scopes: z.array(z.string().min(1).max(100)).max(500).optional(),
  })
  .strict();
const roleParams = z.object({ code: z.string().min(1).max(50) });
const areaBody = z
  .object({ area: z.string().regex(AREA), description: z.string().trim().min(1).max(255) })
  .strict();

// Thrown inside a change that would leave the person acting without the right to manage users
class LockedOut extends Error {}

// zod speaks English; the person reads which field to fix in Spanish
const FIELDS: Record<string, string> = {
  email: "el correo",
  displayName: "el nombre",
  role: "el rol",
  password: "la contraseña",
  code: "el código (minúsculas, números, guion y guion bajo)",
  description: "la descripción",
  scopes: "los permisos",
};

/**
 * Names in Spanish the fields a body got wrong
 *
 * @param   error  The failed parse
 *
 * @return  The message
 */
function invalidFields(error: z.ZodError): string {
  const fields = new Set(error.issues.map((issue) => FIELDS[String(issue.path[0])] ?? "un campo"));

  return `Revisa ${[...fields].join(", ")}`;
}

const USER_NOT_FOUND = { ok: false, error: "user_not_found", message: "Esa cuenta ya no existe" };

/**
 * Lists who may manage users right now: active people whose active role holds the scope, or who
 * have it as an extra still in force
 *
 * @param   db  Own database, or the transaction of a change
 *
 * @return  Their ids
 */
async function managers(db: Pick<Database, "execute">): Promise<number[]> {
  const result = await db.execute(sql`
    select u.id from users u
    join roles r on r.id = u.primary_role_id and r.active
    join role_scopes rs on rs.role_id = r.id
    join scopes s on s.id = rs.scope_id and s.code = ${MANAGE} and s.deleted_at is null
    where u.active and u.deleted_at is null
    union
    select u.id from users u
    join user_extra_scopes ue on ue.user_id = u.id and (ue.expires_at is null or ue.expires_at > now())
    join scopes s on s.id = ue.scope_id and s.code = ${MANAGE} and s.deleted_at is null
    where u.active and u.deleted_at is null`);

  return (result.rows as { id: number }[]).map((row) => Number(row.id));
}

/**
 * Registers the administration of people, their extra permissions, roles and document areas
 *
 * @param   app      Fastify instance
 * @param   options  Database
 */
export default async function usersRoutes(
  app: FastifyInstance,
  options: UsersRoutesOptions,
): Promise<void> {
  const { db } = options;
  const guard = { preHandler: [app.requireAuth, app.requireScope(MANAGE)] };

  /**
   * Runs a change and keeps it only if the person making it can still manage users afterwards,
   * which also means someone always can
   *
   * @param   request  Request of the person acting
   * @param   reply    Reply, for the refusal
   * @param   change   The writes, inside one transaction
   *
   * @return  Whether the change was kept
   */
  const keepingAccess = async (
    request: FastifyRequest,
    reply: FastifyReply,
    change: (tx: Parameters<Parameters<Database["transaction"]>[0]>[0]) => Promise<void>,
  ): Promise<boolean> => {
    try {
      await db.transaction(async (tx) => {
        // Changes that can take the right away run one at a time, so two at once cannot both pass
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${MANAGE}))`);
        await change(tx);
        if (!(await managers(tx)).includes(request.authUser?.id ?? 0)) {
          throw new LockedOut();
        }
      });
      return true;
    } catch (error) {
      if (error instanceof LockedOut) {
        reply.code(409).send({
          ok: false,
          error: "locked_out",
          message: "Ese cambio te dejaría sin poder administrar usuarios; pídeselo a otra persona",
        });
        return false;
      }
      throw error;
    }
  };

  /**
   * Records a change made by the person acting
   *
   * @param   request    Request of the person acting
   * @param   eventCode  Event
   * @param   message    What changed, in Spanish
   * @param   metadata   Details of the change
   *
   * @return  Once recorded
   */
  const audit = (request: FastifyRequest, eventCode: string, message: string, metadata: object) =>
    logAudit(db, {
      userId: request.authUser?.id ?? null,
      level: "info",
      eventCode,
      message,
      ip: request.ip,
      metadata: metadata as Record<string, unknown>,
    });

  /**
   * Refuses a change that gives or touches scopes the person acting does not hold, so managing
   * users is never a way up nor a way to strip someone who holds more
   *
   * @param   request  Request of the person acting
   * @param   reply    Reply, for the refusal
   * @param   codes    Scopes the change gives or touches
   *
   * @return  Whether the change may go on
   */
  const within = (request: FastifyRequest, reply: FastifyReply, codes: Iterable<string>) => {
    const missing = [...new Set(codes)].filter((code) => !request.authUser?.scopes.has(code));
    if (missing.length === 0) {
      return true;
    }
    reply.code(403).send({
      ok: false,
      error: "beyond_own_scopes",
      message: `No puedes dar ni quitar permisos que no tienes: ${missing.sort().join(", ")}`,
    });

    return false;
  };

  /**
   * Lists the scopes a role gives
   *
   * @param   id  Role
   *
   * @return  Their codes
   */
  const roleCodes = async (id: number) =>
    (
      await db
        .select({ code: scopes.code })
        .from(roleScopes)
        .innerJoin(scopes, and(eq(scopes.id, roleScopes.scopeId), isNull(scopes.deletedAt)))
        .where(eq(roleScopes.roleId, id))
    ).map((row) => row.code);

  /**
   * Finds an active role by its code
   *
   * @param   code  Role code
   *
   * @return  Its id, or undefined when it does not exist or is switched off
   */
  const roleId = async (code: string) =>
    (
      await db
        .select({ id: roles.id })
        .from(roles)
        .where(and(eq(roles.code, code), eq(roles.active, true), isNull(roles.deletedAt)))
    )[0]?.id;

  app.get("/admin/users", guard, async () => {
    const people = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: roles.code,
        active: users.active,
        isService: users.isService,
        hasPassword: sql<boolean>`${users.passwordHash} is not null`,
        createdAt: users.createdAt,
      })
      .from(users)
      // A switched-off role gives nothing, so the person shows as having none
      .leftJoin(roles, and(eq(roles.id, users.primaryRoleId), eq(roles.active, true)))
      .where(isNull(users.deletedAt))
      .orderBy(asc(users.displayName), asc(users.id));
    const extras = await db
      .select({
        userId: userExtraScopes.userId,
        code: scopes.code,
        expiresAt: userExtraScopes.expiresAt,
        reason: userExtraScopes.reason,
        expired: sql<boolean>`coalesce(${userExtraScopes.expiresAt} <= now(), false)`,
      })
      .from(userExtraScopes)
      .innerJoin(scopes, and(eq(scopes.id, userExtraScopes.scopeId), isNull(scopes.deletedAt)));
    const identities = await db
      .select({ userId: userIdentities.userId, system: userIdentities.systemCode })
      .from(userIdentities)
      .where(isNull(userIdentities.deletedAt));

    return {
      ok: true,
      data: people.map((person) => ({
        ...person,
        extraScopes: extras
          .filter((extra) => extra.userId === person.id)
          .map(({ code, expiresAt, reason, expired }) => ({ code, expiresAt, reason, expired })),
        systems: identities
          .filter((identity) => identity.userId === person.id)
          .map((identity) => identity.system),
      })),
    };
  });

  app.post("/admin/users", guard, async (request, reply) => {
    const body = userBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_body",
        message: invalidFields(body.error),
      });
    }
    const role = await roleId(body.data.role);
    if (!role) {
      return reply
        .code(400)
        .send({ ok: false, error: "unknown_role", message: "Ese rol no existe" });
    }
    if (!within(request, reply, await roleCodes(role))) {
      return reply;
    }
    const { password } = body.data;
    if (password) {
      const problem = passwordProblem(password, [body.data.email, body.data.displayName]);
      if (problem) {
        return reply.code(400).send({ ok: false, error: "weak_password", message: problem });
      }
    }
    const [taken] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${body.data.email}`);
    if (taken) {
      return reply
        .code(409)
        .send({ ok: false, error: "email_taken", message: "Ya hay una cuenta con ese correo" });
    }

    // Without a password the account waits for the person to set one through a mailed link
    const [created] = await db
      .insert(users)
      .values({
        email: body.data.email,
        displayName: body.data.displayName,
        primaryRoleId: role,
        passwordHash: password ? await hashPassword(password) : null,
        createdBy: request.authUser?.id ?? null,
      })
      .returning({ id: users.id });
    await audit(request, "users.created", `Cuenta ${created?.id} creada`, {
      target: created?.id,
      email: body.data.email,
      role: body.data.role,
    });

    return reply.code(201).send({ ok: true, data: { id: created?.id } });
  });

  app.patch("/admin/users/:id", guard, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    const body = userChange.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply
        .code(400)
        .send({ ok: false, error: "invalid_body", message: "El nombre o el rol no son válidos" });
    }
    const id = params.data.id;
    const [before] = await db
      .select({
        displayName: users.displayName,
        roleId: users.primaryRoleId,
        active: users.active,
      })
      .from(users)
      .where(and(eq(users.id, id), isNull(users.deletedAt)));
    if (!before) {
      return reply.code(404).send(USER_NOT_FOUND);
    }
    const role = body.data.role === undefined ? before.roleId : await roleId(body.data.role);
    if (!role) {
      return reply
        .code(400)
        .send({ ok: false, error: "unknown_role", message: "Ese rol no existe" });
    }
    const target = await resolveUser(db, id);
    const given = body.data.role === undefined ? [] : await roleCodes(role);
    if (!within(request, reply, [...(target?.scopes ?? []), ...given])) {
      return reply;
    }

    const kept = await keepingAccess(request, reply, async (tx) => {
      await tx
        .update(users)
        .set({
          displayName: body.data.displayName ?? before.displayName,
          primaryRoleId: role,
          active: body.data.active ?? before.active,
          // Someone switched off loses every session at once
          ...(body.data.active === false
            ? { tokensRevokedAt: sql`date_trunc('second', now())` }
            : {}),
          updatedBy: request.authUser?.id ?? null,
        })
        .where(eq(users.id, id));
    });
    if (!kept) {
      return reply;
    }
    await audit(request, "users.changed", `Cuenta ${id} cambiada`, {
      target: id,
      before,
      after: { ...body.data, roleId: role },
    });

    return { ok: true, data: { id } };
  });

  app.delete("/admin/users/:id", guard, async (request, reply) => {
    const params = idParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ ok: false, error: "invalid_id" });
    }
    const id = params.data.id;
    if (!within(request, reply, (await resolveUser(db, id))?.scopes ?? [])) {
      return reply;
    }
    const kept = await keepingAccess(request, reply, async (tx) => {
      const deleted = await tx
        .update(users)
        .set({
          deletedAt: sql`now()`,
          deletedBy: request.authUser?.id ?? null,
          active: false,
          tokensRevokedAt: sql`date_trunc('second', now())`,
        })
        .where(and(eq(users.id, id), isNull(users.deletedAt)))
        .returning({ id: users.id });
      if (deleted.length === 0) {
        throw new NotFound();
      }
    }).catch((error) => {
      if (error instanceof NotFound) {
        reply.code(404).send(USER_NOT_FOUND);
        return false;
      }
      throw error;
    });
    if (!kept) {
      return reply;
    }
    await audit(request, "users.deleted", `Cuenta ${id} borrada`, { target: id });

    return { ok: true, data: { id } };
  });

  app.put("/admin/users/:id/scopes/:code", guard, async (request, reply) => {
    const params = grantParams.safeParse(request.params);
    const body = grantBody.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_body",
        message: "Hace falta el motivo, y una fecha de vencimiento válida si la tiene",
      });
    }
    const [scope] = await db
      .select({ id: scopes.id })
      .from(scopes)
      .where(and(eq(scopes.code, params.data.code), isNull(scopes.deletedAt)));
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, params.data.id), isNull(users.deletedAt)));
    if (!scope || !user) {
      return reply
        .code(404)
        .send({ ok: false, error: "not_found", message: "Esa cuenta o ese permiso ya no existen" });
    }
    const expiresAt = body.data.expiresAt ? new Date(body.data.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_body",
        message: "La fecha de vencimiento ya pasó",
      });
    }
    if (!within(request, reply, [params.data.code])) {
      return reply;
    }
    // Renewing an extra replaces its expiry, which can take the right away like a removal
    const kept = await keepingAccess(request, reply, async (tx) => {
      await tx
        .insert(userExtraScopes)
        .values({
          userId: user.id,
          scopeId: scope.id,
          expiresAt,
          reason: body.data.reason,
          grantedBy: request.authUser?.id ?? null,
        })
        .onConflictDoUpdate({
          target: [userExtraScopes.userId, userExtraScopes.scopeId],
          set: { expiresAt, reason: body.data.reason, grantedBy: request.authUser?.id ?? null },
        });
    });
    if (!kept) {
      return reply;
    }
    await audit(request, "users.scope_granted", `${params.data.code} para la cuenta ${user.id}`, {
      target: user.id,
      scope: params.data.code,
      expiresAt,
      reason: body.data.reason,
    });

    return { ok: true, data: { id: user.id, code: params.data.code } };
  });

  app.delete("/admin/users/:id/scopes/:code", guard, async (request, reply) => {
    const params = grantParams.safeParse(request.params);
    if (!params.success) {
      return reply
        .code(400)
        .send({ ok: false, error: "invalid_body", message: "Pedido no válido" });
    }
    const [scope] = await db
      .select({ id: scopes.id })
      .from(scopes)
      .where(eq(scopes.code, params.data.code));
    if (!within(request, reply, [params.data.code])) {
      return reply;
    }
    const kept = await keepingAccess(request, reply, async (tx) => {
      const removed = await tx
        .delete(userExtraScopes)
        .where(
          and(
            eq(userExtraScopes.userId, params.data.id),
            eq(userExtraScopes.scopeId, scope?.id ?? 0),
          ),
        )
        .returning({ id: userExtraScopes.userId });
      if (removed.length === 0) {
        throw new NotFound();
      }
    }).catch((error) => {
      if (error instanceof NotFound) {
        reply
          .code(404)
          .send({ ok: false, error: "not_found", message: "Esa persona no tenía ese permiso" });
        return false;
      }
      throw error;
    });
    if (!kept) {
      return reply;
    }
    await audit(
      request,
      "users.scope_revoked",
      `${params.data.code} quitado a la cuenta ${params.data.id}`,
      {
        target: params.data.id,
        scope: params.data.code,
      },
    );

    return { ok: true, data: { id: params.data.id, code: params.data.code } };
  });

  app.get("/admin/roles", guard, async () => {
    const all = await db
      .select({
        id: roles.id,
        code: roles.code,
        description: roles.description,
        active: roles.active,
      })
      .from(roles)
      .where(isNull(roles.deletedAt))
      .orderBy(asc(roles.code));
    const links = await db
      .select({ roleId: roleScopes.roleId, code: scopes.code })
      .from(roleScopes)
      .innerJoin(scopes, and(eq(scopes.id, roleScopes.scopeId), isNull(scopes.deletedAt)));
    const people = await db
      .select({ roleId: users.primaryRoleId, total: count() })
      .from(users)
      .where(isNull(users.deletedAt))
      .groupBy(users.primaryRoleId);

    return {
      ok: true,
      data: all.map((role) => ({
        code: role.code,
        description: role.description,
        active: role.active,
        // The admin role follows every scope by itself; it is never edited by hand
        protected: role.code === ADMIN_ROLE,
        scopes: links
          .filter((link) => link.roleId === role.id)
          .map((link) => link.code)
          .sort(),
        people: Number(people.find((row) => row.roleId === role.id)?.total ?? 0),
      })),
    };
  });

  /**
   * Finds the ids of scopes by their codes, refusing any that does not exist
   *
   * @param   codes  Codes asked for
   *
   * @return  Their ids, or the codes that do not exist
   */
  const scopeIds = async (codes: string[]): Promise<{ ids: number[] } | { unknown: string[] }> => {
    const unique = [...new Set(codes)];
    const found = unique.length
      ? await db
          .select({ id: scopes.id, code: scopes.code })
          .from(scopes)
          .where(and(inArray(scopes.code, unique), isNull(scopes.deletedAt)))
      : [];
    const unknown = unique.filter((code) => !found.some((scope) => scope.code === code));

    return unknown.length > 0 ? { unknown } : { ids: found.map((scope) => scope.id) };
  };

  app.post("/admin/roles", guard, async (request, reply) => {
    const body = roleBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_body",
        message: invalidFields(body.error),
      });
    }
    const found = await scopeIds(body.data.scopes);
    if ("unknown" in found) {
      return reply.code(400).send({
        ok: false,
        error: "unknown_scope",
        message: `No existen: ${found.unknown.join(", ")}`,
      });
    }
    if (!within(request, reply, body.data.scopes)) {
      return reply;
    }
    const [taken] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.code, body.data.code));
    if (taken) {
      return reply
        .code(409)
        .send({ ok: false, error: "role_taken", message: "Ya hay un rol con ese código" });
    }
    await db.transaction(async (tx) => {
      const [role] = await tx
        .insert(roles)
        .values({
          code: body.data.code,
          description: body.data.description,
          createdBy: request.authUser?.id ?? null,
        })
        .returning({ id: roles.id });
      if (found.ids.length > 0) {
        await tx.insert(roleScopes).values(
          found.ids.map((scopeId) => ({
            roleId: role?.id ?? 0,
            scopeId,
            grantedBy: request.authUser?.id ?? null,
          })),
        );
      }
    });
    await audit(request, "roles.created", `Rol ${body.data.code} creado`, body.data);

    return reply.code(201).send({ ok: true, data: { code: body.data.code } });
  });

  app.put("/admin/roles/:code", guard, async (request, reply) => {
    const params = roleParams.safeParse(request.params);
    const body = roleChange.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_body",
        message: "La descripción o los permisos no son válidos",
      });
    }
    const [role] = await db
      .select({ id: roles.id, description: roles.description, active: roles.active })
      .from(roles)
      .where(and(eq(roles.code, params.data.code), isNull(roles.deletedAt)));
    if (!role) {
      return reply
        .code(404)
        .send({ ok: false, error: "role_not_found", message: "Ese rol ya no existe" });
    }
    // Its scopes grow by themselves with every new source and area; editing them would break that
    if (
      params.data.code === ADMIN_ROLE &&
      (body.data.scopes !== undefined || body.data.active === false)
    ) {
      return reply.code(409).send({
        ok: false,
        error: "role_protected",
        message: "El rol admin siempre tiene todos los permisos y no se desactiva",
      });
    }
    const found = body.data.scopes ? await scopeIds(body.data.scopes) : null;
    if (found && "unknown" in found) {
      return reply.code(400).send({
        ok: false,
        error: "unknown_scope",
        message: `No existen: ${found.unknown.join(", ")}`,
      });
    }
    const before = await db
      .select({ code: scopes.code })
      .from(roleScopes)
      .innerJoin(scopes, eq(scopes.id, roleScopes.scopeId))
      .where(eq(roleScopes.roleId, role.id));
    if (!within(request, reply, [...before.map((row) => row.code), ...(body.data.scopes ?? [])])) {
      return reply;
    }

    const kept = await keepingAccess(request, reply, async (tx) => {
      await tx
        .update(roles)
        .set({
          description: body.data.description ?? role.description,
          active: body.data.active ?? role.active,
          updatedBy: request.authUser?.id ?? null,
        })
        .where(eq(roles.id, role.id));
      if (found) {
        await tx.delete(roleScopes).where(eq(roleScopes.roleId, role.id));
        if (found.ids.length > 0) {
          await tx.insert(roleScopes).values(
            found.ids.map((scopeId) => ({
              roleId: role.id,
              scopeId,
              grantedBy: request.authUser?.id ?? null,
            })),
          );
        }
      }
    });
    if (!kept) {
      return reply;
    }
    await audit(request, "roles.changed", `Rol ${params.data.code} cambiado`, {
      role: params.data.code,
      before: {
        description: role.description,
        active: role.active,
        scopes: before.map((row) => row.code),
      },
      after: body.data,
    });

    return { ok: true, data: { code: params.data.code } };
  });

  app.get("/admin/scopes", guard, async () => ({
    ok: true,
    data: await db
      .select({ code: scopes.code, description: scopes.description, sensitive: scopes.sensitive })
      .from(scopes)
      .where(isNull(scopes.deletedAt))
      .orderBy(asc(scopes.code)),
  }));

  // The only scopes made by hand are areas of documents; the rest come with the code or a source
  app.post("/admin/scopes", guard, async (request, reply) => {
    const body = areaBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_body",
        message: "El área va en minúsculas, números, guion o guion bajo, con una descripción",
      });
    }
    const code = `docs.${body.data.area}.read`;
    const [taken] = await db.select({ id: scopes.id }).from(scopes).where(eq(scopes.code, code));
    if (taken) {
      return reply
        .code(409)
        .send({ ok: false, error: "scope_taken", message: "Esa área ya existe" });
    }
    await db.transaction(async (tx) => {
      const [scope] = await tx
        .insert(scopes)
        .values({
          code,
          description: body.data.description,
          createdBy: request.authUser?.id ?? null,
        })
        .returning({ id: scopes.id });
      // The admin role reads every area, as it holds every scope
      const [admin] = await tx
        .select({ id: roles.id })
        .from(roles)
        .where(eq(roles.code, ADMIN_ROLE));
      if (admin && scope) {
        await tx
          .insert(roleScopes)
          .values({ roleId: admin.id, scopeId: scope.id })
          .onConflictDoNothing();
      }
    });
    await audit(request, "scopes.created", `Área ${body.data.area} creada`, { code });

    return reply.code(201).send({ ok: true, data: { code } });
  });
}

// Thrown inside a change whose target does not exist
class NotFound extends Error {}

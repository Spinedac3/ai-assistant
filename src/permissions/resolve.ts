import { and, eq, gt, isNull, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { roleScopes, roles, scopes, userExtraScopes, users } from "../db/schema.js";

export interface ResolvedUser {
  id: number;
  email: string;
  displayName: string;
  active: boolean;
  roleCode: string | null;
  scopes: Set<string>;
  tokensRevokedAt: Date | null;
}

/**
 * Loads a user with the effective scopes: those of the role plus the unexpired extras
 *
 * @param   db      Own database
 * @param   userId  User to resolve
 *
 * @return  The user, or null when missing or deleted
 */
export async function resolveUser(db: Database, userId: number): Promise<ResolvedUser | null> {
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      active: users.active,
      roleId: users.primaryRoleId,
      roleCode: roles.code,
      tokensRevokedAt: users.tokensRevokedAt,
    })
    .from(users)
    .leftJoin(roles, and(eq(roles.id, users.primaryRoleId), eq(roles.active, true)))
    .where(and(eq(users.id, userId), isNull(users.deletedAt)))
    .limit(1);

  if (!user) {
    return null;
  }

  const roleScopeRows = user.roleCode
    ? await db
        .select({ code: scopes.code })
        .from(roleScopes)
        .innerJoin(scopes, eq(scopes.id, roleScopes.scopeId))
        .where(and(eq(roleScopes.roleId, user.roleId ?? 0), isNull(scopes.deletedAt)))
    : [];

  const extraRows = await db
    .select({ code: scopes.code })
    .from(userExtraScopes)
    .innerJoin(scopes, eq(scopes.id, userExtraScopes.scopeId))
    .where(
      and(
        eq(userExtraScopes.userId, userId),
        or(isNull(userExtraScopes.expiresAt), gt(userExtraScopes.expiresAt, sql`now()`)),
        isNull(scopes.deletedAt),
      ),
    );

  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    active: user.active,
    roleCode: user.roleCode,
    scopes: new Set([...roleScopeRows, ...extraRows].map((row) => row.code)),
    tokensRevokedAt: user.tokensRevokedAt,
  };
}

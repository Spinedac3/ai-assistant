import { and, eq, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { roles, userIdentities, users } from "../db/schema.js";
import type { ExternalSystem, SystemIdentity } from "./externalSystems.js";
import { verifyPassword } from "./password.js";

const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export type PasswordLogin =
  | { outcome: "ok"; userId: number }
  | { outcome: "invalid" | "locked" | "inactive"; userId: number | null };

/**
 * Checks an email and password, counting failures and locking the account after too many
 *
 * @param   db        Own database
 * @param   email     Login email, any case
 * @param   password  Plain password
 *
 * @return  The outcome; the caller shows the same message for every failure
 */
export async function loginWithPassword(
  db: Database,
  email: string,
  password: string,
): Promise<PasswordLogin> {
  const [user] = await db
    .select({
      id: users.id,
      passwordHash: users.passwordHash,
      active: users.active,
      lockedUntil: users.lockedUntil,
    })
    .from(users)
    .where(and(eq(sql`lower(${users.email})`, email.trim().toLowerCase()), isNull(users.deletedAt)))
    .limit(1);

  const matches = await verifyPassword(user?.passwordHash ?? null, password);

  if (!user) {
    return { outcome: "invalid", userId: null };
  }

  if (user.lockedUntil && user.lockedUntil > new Date()) {
    return { outcome: "locked", userId: user.id };
  }

  if (!matches) {
    await db
      .update(users)
      .set({
        failedLogins: sql`case when ${users.failedLogins} + 1 >= ${MAX_FAILED_LOGINS} then 0 else ${users.failedLogins} + 1 end`,
        lockedUntil: sql`case when ${users.failedLogins} + 1 >= ${MAX_FAILED_LOGINS} then now() + make_interval(mins => ${LOCK_MINUTES}) else null end`,
      })
      .where(eq(users.id, user.id));

    return { outcome: "invalid", userId: user.id };
  }

  await db.update(users).set({ failedLogins: 0, lockedUntil: null }).where(eq(users.id, user.id));

  if (!user.active) {
    return { outcome: "inactive", userId: user.id };
  }

  return { outcome: "ok", userId: user.id };
}

/**
 * Finds the user behind an external identity, creating or linking it when the system allows
 *
 * @param   db        Own database
 * @param   system    System that vouched for the identity
 * @param   identity  Identity from the verified token
 *
 * @return  The user id and whether it was just created, or null when the identity is unknown
 */
export async function userForIdentity(
  db: Database,
  system: ExternalSystem,
  identity: SystemIdentity,
): Promise<{ userId: number; created: boolean } | null> {
  // The identity is the stable key; looking up by email first can split one person in two
  const [known] = await db
    .select({ userId: userIdentities.userId })
    .from(userIdentities)
    .innerJoin(users, eq(users.id, userIdentities.userId))
    .where(
      and(
        eq(userIdentities.systemCode, identity.systemCode),
        eq(userIdentities.externalId, identity.externalId),
        isNull(userIdentities.deletedAt),
        isNull(users.deletedAt),
      ),
    )
    .limit(1);

  if (known) {
    return { userId: known.userId, created: false };
  }

  if (!system.autoProvisionRole) {
    return null;
  }

  const findByEmail = async () => {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(
        and(eq(sql`lower(${users.email})`, identity.email.toLowerCase()), isNull(users.deletedAt)),
      )
      .limit(1);

    return row?.id;
  };

  let userId = await findByEmail();
  let created = false;

  if (!userId) {
    const [role] = await db
      .select({ id: roles.id })
      .from(roles)
      .where(eq(roles.code, system.autoProvisionRole))
      .limit(1);

    if (!role) {
      throw new Error(`El rol de aprovisionamiento '${system.autoProvisionRole}' no existe`);
    }

    const [inserted] = await db
      .insert(users)
      .values({ email: identity.email, displayName: identity.name, primaryRoleId: role.id })
      .onConflictDoNothing()
      .returning({ id: users.id });

    // A concurrent first login may have created the same email a moment ago
    created = inserted !== undefined;
    userId = inserted?.id ?? (await findByEmail());
  }

  if (!userId) {
    throw new Error("No se pudo crear el usuario");
  }

  // Two first logins at once race here; the unique index keeps a single identity
  const linked = await db
    .insert(userIdentities)
    .values({ userId, systemCode: identity.systemCode, externalId: identity.externalId })
    .onConflictDoNothing()
    .returning({ userId: userIdentities.userId });

  // The system vouched the email is this person's; a password someone else may have set on the
  // account before must not stay as a second way in. The previous second keeps the session about
  // to be issued alive
  if (linked.length > 0 && !created) {
    await db
      .update(users)
      .set({
        passwordHash: null,
        tokensRevokedAt: sql`date_trunc('second', now()) - interval '1 second'`,
      })
      .where(and(eq(users.id, userId), sql`${users.passwordHash} is not null`));
  }

  return { userId, created };
}

import { inArray } from "drizzle-orm";
import type { Database } from "./client.js";
import { roleScopes, roles, scopes } from "./schema.js";

// Each slice adds the scopes it guards; the admin role always holds all of them
const SCOPES = [
  { code: "chat.use", description: "Conversar con el asistente", sensitive: false },
  { code: "users.manage", description: "Administrar usuarios, roles y permisos", sensitive: true },
  {
    code: "settings.manage",
    description: "Cambiar la configuración del asistente",
    sensitive: true,
  },
];

const ROLES = [
  { code: "admin", description: "Administrador", scopes: SCOPES.map((scope) => scope.code) },
  { code: "user", description: "Usuario", scopes: ["chat.use"] },
];

/**
 * Creates the base roles and scopes; running it again changes nothing that exists
 *
 * @param   db  Own database
 */
export async function seedBase(db: Database): Promise<void> {
  await db.insert(scopes).values(SCOPES).onConflictDoNothing();
  await db
    .insert(roles)
    .values(ROLES.map(({ code, description }) => ({ code, description })))
    .onConflictDoNothing();

  const scopeRows = await db
    .select({ id: scopes.id, code: scopes.code })
    .from(scopes)
    .where(
      inArray(
        scopes.code,
        SCOPES.map((scope) => scope.code),
      ),
    );
  const roleRows = await db
    .select({ id: roles.id, code: roles.code })
    .from(roles)
    .where(
      inArray(
        roles.code,
        ROLES.map((role) => role.code),
      ),
    );

  const scopeIds = new Map(scopeRows.map((row) => [row.code, row.id]));
  const grants = roleRows.flatMap((role) =>
    (ROLES.find((entry) => entry.code === role.code)?.scopes ?? []).map((code) => ({
      roleId: role.id,
      scopeId: scopeIds.get(code) ?? 0,
    })),
  );

  await db.insert(roleScopes).values(grants).onConflictDoNothing();
}

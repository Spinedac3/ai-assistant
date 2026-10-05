import { count, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import {
  roleScopes,
  roles,
  scopes,
  sources,
  toolDefinitions,
  userExtraScopes,
} from "../db/schema.js";
import type { Secrets } from "../vault/envelope.js";
import { type ConnectionInfo, writeAbilities } from "./engines.js";

const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mssql: 1433 } as const;

// An IANA zone, as the engines and Intl read it
export const timeZone = z
  .string()
  .refine((value) => Intl.supportedValuesOf("timeZone").includes(value) || value === "UTC", {
    message: "zona horaria IANA desconocida",
  });

export const SOURCE_CODE = /^[a-z0-9_-]{2,50}$/;

/**
 * Names the permission that lets a person use the tools made over a source
 *
 * @param   code  Source code
 *
 * @return  The scope code
 */
export function sourceScope(code: string): string {
  return `sources.${code}.use`;
}

export const sourceInput = z.object({
  code: z.string().regex(SOURCE_CODE, "minúsculas, números, guion y guion bajo"),
  name: z.string().trim().min(1).max(200),
  engine: z.enum(["postgres", "mysql", "mssql"]),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535).optional(),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(512),
  timeZone: timeZone.nullable().optional(),
  tls: z.boolean().default(true),
});

export type SourceInput = z.infer<typeof sourceInput>;

export interface SourceSummary {
  code: string;
  name: string;
  engine: string;
  host: string;
  port: number;
  database: string;
  username: string;
  timeZone: string | null;
  tls: boolean;
}

export type Verification =
  | { ok: true }
  | { ok: false; error: "connection_failed"; message: string; detail: string }
  | { ok: false; error: "not_read_only"; abilities: string[] };

/**
 * Removes the password from a driver message, in case a driver ever echoes it
 *
 * @param   message   Error message
 * @param   password  Password to hide
 *
 * @return  The message without it
 */
function redact(message: string, password: string): string {
  return password ? message.split(password).join("***") : message;
}

/**
 * Names what failed in a connection, without the driver's details: those reach the server log
 * only, since they would map the internal network for whoever registers sources
 *
 * @param   error  Driver error
 *
 * @return  The problem, in Spanish
 */
export function connectionProblem(error: unknown): string {
  const failure = error as { code?: unknown; message?: unknown };
  const code = String(failure.code ?? "");
  const message = String(failure.message ?? "");

  if (
    ["28P01", "28000", "ER_ACCESS_DENIED_ERROR"].includes(code) ||
    /login failed/i.test(message)
  ) {
    return "Usuario o contraseña incorrectos";
  }
  if (["3D000", "ER_BAD_DB_ERROR"].includes(code) || /cannot open database/i.test(message)) {
    return "La base no existe o el usuario no puede abrirla";
  }
  if (/certificate|ssl|tls/i.test(message)) {
    return "Falló la conexión segura (TLS); revisa el certificado del servidor";
  }
  if (
    [
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EHOSTUNREACH",
      "ENETUNREACH",
      "ESOCKET",
      "ETIMEOUT",
    ].includes(code) ||
    /timeout|refused|ENOTFOUND/i.test(message)
  ) {
    return "No se pudo alcanzar el servidor de la base";
  }

  return "No se pudo conectar a la base";
}

/**
 * Connects to a source and checks that its user can only read
 *
 * @param   info  Connection
 *
 * @return  Whether it can be used, and why not; the driver's own message comes apart, for the log
 */
export async function verifySource(info: ConnectionInfo): Promise<Verification> {
  let abilities: string[];
  try {
    abilities = await writeAbilities(info);
  } catch (error) {
    return {
      ok: false,
      error: "connection_failed",
      message: connectionProblem(error),
      detail: redact(String((error as Error).message), info.password),
    };
  }

  return abilities.length === 0 ? { ok: true } : { ok: false, error: "not_read_only", abilities };
}

/**
 * Builds the connection of an input, with the engine's default port
 *
 * @param   input  Source fields
 *
 * @return  The connection
 */
export function connectionOf(input: SourceInput): ConnectionInfo {
  return {
    engine: input.engine,
    host: input.host,
    port: input.port ?? DEFAULT_PORTS[input.engine],
    database: input.database,
    username: input.username,
    password: input.password,
    tls: input.tls,
  };
}

/**
 * Stores a source after it passed verification; the password is sealed with its code as context
 *
 * @param   db       Own database
 * @param   secrets  Vault
 * @param   input    Source fields
 * @param   userId   Who registers it
 *
 * @return  Saved, and whether it now points elsewhere; or refused because its permission's name
 *          already belongs to a permission someone made by hand
 */
export async function saveSource(
  db: Database,
  secrets: Secrets,
  input: SourceInput,
  userId: number,
): Promise<{ saved: true; retargeted: boolean } | { saved: false }> {
  const info = connectionOf(input);
  const values = {
    name: input.name,
    engine: input.engine,
    host: info.host,
    port: info.port,
    database: info.database,
    username: info.username,
    sealedPassword: secrets.seal(input.password, `source:${input.code}`),
    timeZone: input.timeZone ?? null,
    tls: input.tls,
  };

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(sources).where(eq(sources.code, input.code));
    // A new source never takes over a permission that exists already: the roles holding it
    // would reach this source's data without anyone granting it
    const [taken] = await tx
      .select({ id: scopes.id })
      .from(scopes)
      .where(eq(scopes.code, sourceScope(input.code)));
    if (!before && taken) {
      return { saved: false } as const;
    }

    await tx
      .insert(sources)
      .values({ ...values, code: input.code, createdBy: userId })
      .onConflictDoUpdate({
        target: sources.code,
        set: { ...values, updatedAt: sql`now()` },
      });
    // The admin role holds every permission; the admin then grants this one to the roles that
    // may read this source's data
    const description = `Usar las herramientas de la fuente ${input.name}`;
    const [scope] = await tx
      .insert(scopes)
      .values({ code: sourceScope(input.code), description, sensitive: true, createdBy: userId })
      .onConflictDoUpdate({ target: scopes.code, set: { description } })
      .returning({ id: scopes.id });
    const [admin] = await tx.select({ id: roles.id }).from(roles).where(eq(roles.code, "admin"));
    if (scope && admin) {
      await tx
        .insert(roleScopes)
        .values({ roleId: admin.id, scopeId: scope.id })
        .onConflictDoNothing();
    }

    const retargeted =
      before !== undefined &&
      (before.engine !== values.engine ||
        before.host !== values.host ||
        before.port !== values.port ||
        before.database !== values.database);

    return { saved: true, retargeted } as const;
  });
}

/**
 * Lists the sources without any secret
 *
 * @param   db  Own database
 *
 * @return  The sources
 */
export async function listSources(db: Database): Promise<SourceSummary[]> {
  return db
    .select({
      code: sources.code,
      name: sources.name,
      engine: sources.engine,
      host: sources.host,
      port: sources.port,
      database: sources.database,
      username: sources.username,
      timeZone: sources.timeZone,
      tls: sources.tls,
    })
    .from(sources)
    .orderBy(sources.code);
}

/**
 * Opens the connection of a source, with its password unsealed only now
 *
 * @param   db       Own database
 * @param   secrets  Vault
 * @param   code     Source code
 *
 * @return  The connection and the zone of its dates, or null when there is no such source
 */
export async function connectionFor(
  db: Database,
  secrets: Secrets,
  code: string,
): Promise<{ info: ConnectionInfo; timeZone: string | null } | null> {
  const [row] = await db.select().from(sources).where(eq(sources.code, code)).limit(1);
  if (!row) {
    return null;
  }

  return {
    info: {
      engine: row.engine,
      host: row.host,
      port: row.port,
      database: row.database,
      username: row.username,
      password: secrets.open(row.sealedPassword, `source:${row.code}`),
      tls: row.tls,
    },
    timeZone: row.timeZone,
  };
}

/**
 * Deletes a source
 *
 * @param   db    Own database
 * @param   code  Source code
 *
 * @return  Deleted, missing, or still holding tools made over it
 */
export async function deleteSource(
  db: Database,
  code: string,
): Promise<"deleted" | "missing" | "in_use"> {
  const [tools] = await db
    .select({ total: count() })
    .from(toolDefinitions)
    .where(eq(toolDefinitions.sourceCode, code));
  if ((tools?.total ?? 0) > 0) {
    return "in_use";
  }

  // A tool made between the count and the delete is caught by the foreign key
  return db
    .transaction(async (tx) => {
      const removed = await tx
        .delete(sources)
        .where(eq(sources.code, code))
        .returning({ id: sources.id });
      // Its permission goes too, with every grant of it, so no role keeps a scope that means nothing
      const [scope] = await tx
        .delete(scopes)
        .where(eq(scopes.code, sourceScope(code)))
        .returning({ id: scopes.id });
      if (scope) {
        await tx.delete(roleScopes).where(eq(roleScopes.scopeId, scope.id));
        await tx.delete(userExtraScopes).where(eq(userExtraScopes.scopeId, scope.id));
      }

      return removed.length > 0 ? ("deleted" as const) : ("missing" as const);
    })
    .catch((error: { code?: string; cause?: { code?: string } }) => {
      if ((error.cause?.code ?? error.code) === "23503") {
        return "in_use" as const;
      }
      throw error;
    });
}

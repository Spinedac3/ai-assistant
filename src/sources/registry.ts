import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { sources } from "../db/schema.js";
import type { Secrets } from "../vault/envelope.js";
import { type ConnectionInfo, writeAbilities } from "./engines.js";

const DEFAULT_PORTS = { postgres: 5432, mysql: 3306, mssql: 1433 } as const;

const zone = z
  .string()
  .refine((value) => Intl.supportedValuesOf("timeZone").includes(value) || value === "UTC", {
    message: "zona horaria IANA desconocida",
  });

export const sourceInput = z.object({
  code: z.string().regex(/^[a-z0-9_-]{2,50}$/, "minúsculas, números, guion y guion bajo"),
  name: z.string().trim().min(1).max(200),
  engine: z.enum(["postgres", "mysql", "mssql"]),
  host: z.string().trim().min(1).max(255),
  port: z.number().int().min(1).max(65_535).optional(),
  database: z.string().trim().min(1).max(128),
  username: z.string().trim().min(1).max(128),
  password: z.string().min(1).max(512),
  timeZone: zone.nullable().optional(),
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
  active: boolean;
}

export type Verification =
  | { ok: true }
  | { ok: false; error: "connection_failed"; message: string }
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
 * Connects to a source and checks that its user can only read
 *
 * @param   info  Connection
 *
 * @return  Whether it can be used, and why not
 */
export async function verifySource(info: ConnectionInfo): Promise<Verification> {
  let abilities: string[];
  try {
    abilities = await writeAbilities(info);
  } catch (error) {
    return {
      ok: false,
      error: "connection_failed",
      message: redact((error as Error).message, info.password),
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
 */
export async function saveSource(
  db: Database,
  secrets: Secrets,
  input: SourceInput,
  userId: number,
): Promise<void> {
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

  await db
    .insert(sources)
    .values({ ...values, code: input.code, createdBy: userId })
    .onConflictDoUpdate({
      target: sources.code,
      set: { ...values, active: true, updatedAt: sql`now()` },
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
      active: sources.active,
    })
    .from(sources)
    .orderBy(sources.code);
}

/**
 * Opens the connection of an active source, with its password unsealed only now
 *
 * @param   db       Own database
 * @param   secrets  Vault
 * @param   code     Source code
 *
 * @return  The connection and the zone of its dates, or null when there is no such active source
 */
export async function connectionFor(
  db: Database,
  secrets: Secrets,
  code: string,
): Promise<{ info: ConnectionInfo; timeZone: string | null } | null> {
  const [row] = await db.select().from(sources).where(eq(sources.code, code)).limit(1);
  if (!row?.active) {
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
 * @return  Whether it existed
 */
export async function deleteSource(db: Database, code: string): Promise<boolean> {
  const removed = await db
    .delete(sources)
    .where(eq(sources.code, code))
    .returning({ id: sources.id });

  return removed.length > 0;
}

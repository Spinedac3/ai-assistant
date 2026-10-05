import mssql from "mssql";
import mysql from "mysql2";
import pg from "pg";

export type EngineName = "postgres" | "mysql" | "mssql";

export interface ConnectionInfo {
  engine: EngineName;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  tls: boolean;
}

export interface QueryLimits {
  timeoutMs: number;
  // Rows read before giving up; the query is cut, never loaded whole into memory
  maxRows: number;
}

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
}

export class TooManyRowsError extends Error {}

const CONNECT_TIMEOUT_MS = 10_000;

// Dates without a zone come back as written; the zone of the source gives them meaning later
const PG_TEXT_TYPES = new Set([1082, 1114, 1184]);

/**
 * Formats a driver date as the naive text the source stored
 *
 * @param   value  Value from the driver
 *
 * @return  The value, dates as YYYY-MM-DD HH:MM:SS with milliseconds only when there are any
 */
function plainValue(value: unknown): unknown {
  return value instanceof Date
    ? value
        .toISOString()
        .replace("T", " ")
        .replace(/\.000Z$|Z$/, "")
    : value;
}

/**
 * Runs a read-only query on Postgres, inside a read-only transaction
 *
 * @param   info    Connection
 * @param   sql     Query with $1 placeholders
 * @param   params  Values
 * @param   limits  Timeout and rows
 *
 * @return  Columns and rows
 */
async function postgresQuery(
  info: ConnectionInfo,
  sql: string,
  params: unknown[],
  limits: QueryLimits,
): Promise<QueryResult> {
  const client = new pg.Client({
    host: info.host,
    port: info.port,
    database: info.database,
    user: info.username,
    password: info.password,
    ssl: info.tls ? { rejectUnauthorized: true } : false,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: limits.timeoutMs,
    types: {
      getTypeParser: ((oid: number, format: "text" | "binary") =>
        PG_TEXT_TYPES.has(oid)
          ? (text: string) => text
          : pg.types.getTypeParser(oid, format)) as typeof pg.types.getTypeParser,
    },
  });
  await client.connect();

  try {
    await client.query("BEGIN READ ONLY");
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];

    await new Promise<void>((resolve, reject) => {
      const query = client.query(new pg.Query(sql, params));
      let stopped = false;
      query.on("row", (row: Record<string, unknown>, result?: pg.QueryResult) => {
        if (stopped) {
          return;
        }
        if (columns.length === 0 && result) {
          columns = result.fields.map((field) => field.name);
        }
        rows.push(row);
        if (rows.length > limits.maxRows) {
          // Ending the connection is the only way to stop a query that is still sending
          stopped = true;
          reject(new TooManyRowsError());
          client.end().catch(() => {});
        }
      });
      query.on("end", (result: pg.QueryResult) => {
        columns = columns.length > 0 ? columns : result.fields.map((field) => field.name);
        resolve();
      });
      query.on("error", reject);
    });

    await client.query("ROLLBACK");

    return { columns, rows };
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Runs a read-only query on MySQL, inside a read-only transaction
 *
 * @param   info    Connection
 * @param   sql     Query with ? placeholders
 * @param   params  Values
 * @param   limits  Timeout and rows
 *
 * @return  Columns and rows
 */
async function mysqlQuery(
  info: ConnectionInfo,
  sql: string,
  params: unknown[],
  limits: QueryLimits,
): Promise<QueryResult> {
  const connection = mysql.createConnection({
    host: info.host,
    port: info.port,
    database: info.database,
    user: info.username,
    password: info.password,
    ssl: info.tls ? { rejectUnauthorized: true } : undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
  });
  const run = (text: string) =>
    new Promise<void>((resolve, reject) =>
      connection.query(text, (error) => (error ? reject(error) : resolve())),
    );

  try {
    await run("START TRANSACTION READ ONLY");
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];

    await new Promise<void>((resolve, reject) => {
      let stopped = false;
      connection
        .query({ sql, values: params, timeout: limits.timeoutMs })
        .on("fields", (fields: Array<{ name: string }>) => {
          columns = fields.map((field) => field.name);
        })
        .on("result", (row: Record<string, unknown>) => {
          if (stopped) {
            return;
          }
          rows.push(row);
          if (rows.length > limits.maxRows) {
            stopped = true;
            reject(new TooManyRowsError());
            connection.destroy();
          }
        })
        .on("end", () => resolve())
        .on("error", reject);
    });

    await run("ROLLBACK");

    return { columns, rows };
  } finally {
    connection.destroy();
  }
}

/**
 * Runs a query on SQL Server; it has no read-only transaction, so the read-only user is the
 * barrier, checked when the source is registered
 *
 * @param   info    Connection
 * @param   sql     Query with @p1 placeholders
 * @param   params  Values, bound as p1, p2…
 * @param   limits  Timeout and rows
 *
 * @return  Columns and rows
 */
async function mssqlQuery(
  info: ConnectionInfo,
  sql: string,
  params: unknown[],
  limits: QueryLimits,
): Promise<QueryResult> {
  const pool = new mssql.ConnectionPool({
    server: info.host,
    port: info.port,
    database: info.database,
    user: info.username,
    password: info.password,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: limits.timeoutMs,
    pool: { max: 1, min: 0 },
    // Naive dates read as UTC come back with the same digits they were stored with
    options: { encrypt: info.tls, trustServerCertificate: false, useUTC: true },
  });
  await pool.connect();

  try {
    const request = pool.request();
    request.stream = true;
    for (const [position, value] of params.entries()) {
      request.input(`p${position + 1}`, value);
    }
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];

    await new Promise<void>((resolve, reject) => {
      let stopped = false;
      request.on("recordset", (meta: Record<string, unknown>) => {
        columns = Object.keys(meta);
      });
      request.on("row", (row: Record<string, unknown>) => {
        if (stopped) {
          return;
        }
        rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plainValue(v)])));
        if (rows.length > limits.maxRows) {
          stopped = true;
          reject(new TooManyRowsError());
          request.cancel();
        }
      });
      request.on("error", reject);
      request.on("done", () => resolve());
      request.query(sql);
    });

    return { columns, rows };
  } finally {
    await pool.close().catch(() => {});
  }
}

/**
 * Runs a read-only query on a source
 *
 * @param   info    Connection
 * @param   sql     Query in the engine's own placeholder style
 * @param   params  Values
 * @param   limits  Timeout and rows
 *
 * @return  Columns and rows, dates as naive text
 */
export function runQuery(
  info: ConnectionInfo,
  sql: string,
  params: unknown[],
  limits: QueryLimits,
): Promise<QueryResult> {
  switch (info.engine) {
    case "postgres":
      return postgresQuery(info, sql, params, limits);
    case "mysql":
      return mysqlQuery(info, sql, params, limits);
    case "mssql":
      return mssqlQuery(info, sql, params, limits);
  }
}

// Each engine answers in one row with one 0/1 or boolean column per way of writing
const WRITE_CHECKS: Record<EngineName, string> = {
  postgres: `
    select r.rolsuper as superuser,
      has_database_privilege(current_database(), 'CREATE') as create_schemas,
      exists (
        select 1 from pg_namespace n
        where n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'
          and has_schema_privilege(n.oid, 'CREATE')
      ) as create_tables,
      exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p') and n.nspname not like 'pg\\_%'
          and n.nspname <> 'information_schema'
          and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE')
            or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE'))
      ) as write_rows
    from pg_roles r where r.rolname = current_user`,
  mysql: "SHOW GRANTS FOR CURRENT_USER()",
  mssql: `
    select is_srvrolemember('sysadmin') as sysadmin,
      is_rolemember('db_owner') as db_owner,
      is_rolemember('db_datawriter') as db_datawriter,
      is_rolemember('db_ddladmin') as db_ddladmin,
      has_perms_by_name(db_name(), 'DATABASE', 'INSERT') as insert_any,
      has_perms_by_name(db_name(), 'DATABASE', 'UPDATE') as update_any,
      has_perms_by_name(db_name(), 'DATABASE', 'DELETE') as delete_any,
      has_perms_by_name(db_name(), 'DATABASE', 'CREATE TABLE') as create_tables,
      case when exists (
        select 1 from sys.objects o where o.type = 'U' and (
          has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'INSERT') = 1
          or has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'UPDATE') = 1
          or has_perms_by_name(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT', 'DELETE') = 1)
      ) then 1 else 0 end as write_rows`,
};

// MySQL privileges that change data or structure; USAGE and SELECT are harmless
const MYSQL_WRITES =
  /\b(ALL PRIVILEGES|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|INDEX|TRIGGER|EXECUTE|GRANT OPTION|REFERENCES|EVENT|LOCK TABLES|FILE|SUPER|PROCESS|SHUTDOWN|RELOAD)\b/i;

/**
 * Lists what the user of a source can do besides reading; an empty list means read-only
 *
 * @param   info  Connection
 *
 * @return  The ways it can write
 */
export async function writeAbilities(info: ConnectionInfo): Promise<string[]> {
  const limits = { timeoutMs: CONNECT_TIMEOUT_MS * 3, maxRows: 1_000 };
  const { rows } = await runQuery(info, WRITE_CHECKS[info.engine], [], limits);

  if (info.engine === "mysql") {
    return rows
      .map((row) => String(Object.values(row)[0] ?? ""))
      .map((grant) => grant.match(/^GRANT (.+?) ON /i)?.[1] ?? "")
      .filter((privileges) => MYSQL_WRITES.test(privileges));
  }

  const [found = {}] = rows;

  return Object.entries(found)
    .filter(([, value]) => value === true || value === 1 || value === "1")
    .map(([ability]) => ability);
}

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

export class TooManyRowsError extends Error {
  constructor() {
    super("La consulta devolvió más filas de las permitidas; acótala con filtros");
  }
}

const CONNECT_TIMEOUT_MS = 10_000;
// The permission checks read catalogs, slower than a plain query on a large database
const CHECK_TIMEOUT_MS = 30_000;

// Dates come back as the source wrote them, so every engine gives the same text; the zone of
// the source gives the naive ones their meaning later
const PG_TEXT_TYPES = new Set([1082, 1114, 1184]);

/**
 * Refuses a result whose columns cannot become one field each
 *
 * @param   columns  Column names in order
 */
function checkColumns(columns: string[]): void {
  if (columns.some((column) => column === "") || new Set(columns).size !== columns.length) {
    throw new Error("La consulta tiene columnas repetidas o sin nombre; ponle un alias a cada una");
  }
}

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
  // A connection error after the query ends must not take the whole process down
  client.on("error", () => {});
  await client.connect();

  try {
    await client.query("BEGIN READ ONLY");
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];

    await new Promise<void>((resolve, reject) => {
      // The extended protocol takes one statement only, so no text can end the read-only
      // transaction and go on writing after it
      const config: pg.QueryConfig & { queryMode: "extended" } = {
        text: sql,
        values: params,
        queryMode: "extended",
      };
      const query = client.query(new pg.Query(config));
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
    checkColumns(columns);

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
  // A protocol error with no listener would end the process instead of the query
  connection.on("error", () => {});
  const run = (text: string) =>
    new Promise<void>((resolve, reject) =>
      connection.query(text, (error) => (error ? reject(error) : resolve())),
    );

  try {
    // The client timeout only stops waiting; this one stops the query on the server too
    await run(`SET SESSION max_execution_time = ${Math.trunc(limits.timeoutMs)}`);
    await run("START TRANSACTION READ ONLY");
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];

    await new Promise<void>((resolve, reject) => {
      let stopped = false;
      connection
        .query({ sql, values: params, timeout: limits.timeoutMs })
        // Statements that return no rows come without fields
        .on("fields", (fields?: Array<{ name: string }>) => {
          columns = (fields ?? []).map((field) => field.name);
        })
        .on("result", (row: Record<string, unknown>) => {
          // Without columns the "row" is the server's status packet, not data
          if (stopped || columns.length === 0) {
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
    checkColumns(columns);

    return { columns, rows };
  } finally {
    connection.destroy();
  }
}

/**
 * Runs a query on SQL Server; it has no read-only transaction, so the read-only user is the
 * barrier, checked when the source is registered, and the query also runs in a transaction that
 * is always rolled back
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
  pool.on("error", () => {});
  await pool.connect();
  const transaction = new mssql.Transaction(pool);

  try {
    await transaction.begin();
    await new mssql.Request(transaction).query("SET XACT_ABORT ON");
    const request = new mssql.Request(transaction);
    request.stream = true;
    for (const [position, value] of params.entries()) {
      request.input(`p${position + 1}`, value);
    }
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];

    // Settled only when the request is done: rolling back while it still runs fails, and the
    // transaction would then hold the connection forever
    const failure = await new Promise<Error | null>((resolve) => {
      let stopped: Error | null = null;
      let sets = 0;
      const stop = (error: Error) => {
        if (!stopped) {
          stopped = error;
          request.cancel();
        }
      };
      request.on("recordset", (meta: Record<string, unknown>) => {
        sets++;
        if (sets > 1) {
          stop(new Error("La consulta devolvió más de un resultado; debe ser una sola consulta"));
        }
        columns = Object.keys(meta);
      });
      request.on("row", (row: Record<string, unknown>) => {
        if (stopped) {
          return;
        }
        rows.push(Object.fromEntries(Object.entries(row).map(([k, v]) => [k, plainValue(v)])));
        if (rows.length > limits.maxRows) {
          stop(new TooManyRowsError());
        }
      });
      request.on("error", (error: Error) => {
        stopped ??= error;
      });
      request.on("done", () => resolve(stopped));
      request.query(sql);
    });

    if (failure) {
      throw failure;
    }

    // Repeated names come back as an array under one key
    checkColumns(rows.some((row) => Object.values(row).some(Array.isArray)) ? [""] : columns);

    return { columns, rows };
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    await transaction.rollback().catch(() => {});
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

// Each engine lists, one row per finding, what its user could do besides reading. The rule is
// inverted on purpose: anything that is not plainly a read counts, so a privilege nobody thought
// of still blocks the source. On SQL Server the VIEW permissions only show metadata
const WRITE_CHECKS: Record<"postgres" | "mssql", string> = {
  postgres: `
    select ability from (values
      ('superuser', (select rolsuper from pg_roles where rolname = current_user)),
      ('create_roles', (select rolcreaterole from pg_roles where rolname = current_user)),
      ('create_databases', (select rolcreatedb from pg_roles where rolname = current_user)),
      ('replication', (select rolreplication from pg_roles where rolname = current_user)),
      ('create_schemas', has_database_privilege(current_database(), 'CREATE')),
      ('run_server_programs', pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER')),
      ('write_server_files', pg_has_role(current_user, 'pg_write_server_files', 'MEMBER')),
      ('read_server_files', pg_has_role(current_user, 'pg_read_server_files', 'MEMBER')),
      ('signal_backends', pg_has_role(current_user, 'pg_signal_backend', 'MEMBER')),
      ('create_tables', exists (
        select 1 from pg_namespace n
        where n.nspname not like 'pg_%' and n.nspname <> 'information_schema'
          and has_schema_privilege(n.oid, 'CREATE'))),
      ('write_rows', exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where c.relkind in ('r', 'p', 'v', 'f') and n.nspname not like 'pg_%'
          and n.nspname <> 'information_schema'
          and (has_table_privilege(c.oid, 'INSERT') or has_table_privilege(c.oid, 'UPDATE')
            or has_table_privilege(c.oid, 'DELETE') or has_table_privilege(c.oid, 'TRUNCATE')
            or has_any_column_privilege(c.oid, 'INSERT')
            or has_any_column_privilege(c.oid, 'UPDATE'))))
    ) as checks(ability, found)
    where found`,
  mssql: `
    select ('server ' + permission_name) collate database_default as ability
    from fn_my_permissions(null, 'SERVER')
    where permission_name <> 'CONNECT SQL' and permission_name not like 'VIEW %'
    union
    select ('database ' + permission_name) collate database_default
    from fn_my_permissions(null, 'DATABASE')
    where permission_name not in ('CONNECT', 'SELECT', 'SHOWPLAN', 'REFERENCES')
      and permission_name not like 'VIEW %'
    union
    select ('schema ' + s.name + ' ' + p.permission_name) collate database_default
    from sys.schemas s cross apply fn_my_permissions(quotename(s.name), 'SCHEMA') p
    where s.schema_id between 1 and 16383 and s.name not in ('sys', 'INFORMATION_SCHEMA', 'guest')
      and p.permission_name not in ('SELECT', 'REFERENCES') and p.permission_name not like 'VIEW %'
    union
    select ('object ' + schema_name(o.schema_id) + '.' + o.name + ' ' + p.permission_name)
      collate database_default
    from sys.objects o
    cross apply fn_my_permissions(quotename(schema_name(o.schema_id)) + '.' + quotename(o.name), 'OBJECT') p
    where o.is_ms_shipped = 0 and o.type in ('U', 'V', 'SN', 'P', 'PC', 'X', 'FN', 'IF', 'TF', 'FS', 'FT')
      and p.subentity_name = ''
      and p.permission_name not in ('SELECT', 'REFERENCES') and p.permission_name not like 'VIEW %'
    union
    select ('impersonate ' + d.name + ' ' + p.permission_name) collate database_default
    from sys.database_principals d cross apply fn_my_permissions(quotename(d.name), 'USER') p
    where d.type in ('S', 'U', 'G', 'E', 'X') and d.name <> user_name()
      and p.permission_name in ('IMPERSONATE', 'CONTROL', 'ALTER')`,
};

// The only MySQL privileges that read and nothing else
const MYSQL_READS = new Set(["USAGE", "SELECT", "SHOW VIEW", "SHOW DATABASES"]);

/**
 * Lists the MySQL privileges of a SHOW GRANTS line that are not plain reads
 *
 * @param   grant  One line of SHOW GRANTS
 *
 * @return  Those privileges; a granted role counts as one, since its privileges may be activated
 */
export function mysqlWrites(grant: string): string[] {
  const privileges = grant.match(/^GRANT (.+?) ON /i)?.[1];
  if (!privileges) {
    return /^GRANT /i.test(grant) ? [`role ${grant.replace(/^GRANT (.+?) TO .*$/i, "$1")}`] : [];
  }

  // Column grants carry their own commas, as in SELECT (a, b)
  return privileges
    .replace(/\([^)]*\)/g, "")
    .split(",")
    .map((privilege) => privilege.trim().toUpperCase())
    .filter((privilege) => privilege !== "" && !MYSQL_READS.has(privilege));
}

/**
 * Lists what the user of a source can do besides reading; an empty list means read-only
 *
 * @param   info  Connection
 *
 * @return  The ways it can write or act beyond reading
 */
export async function writeAbilities(info: ConnectionInfo): Promise<string[]> {
  const limits = { timeoutMs: CHECK_TIMEOUT_MS, maxRows: 10_000 };

  if (info.engine === "mysql") {
    const { rows } = await runQuery(info, "SHOW GRANTS FOR CURRENT_USER()", [], limits);
    return rows.flatMap((row) => mysqlWrites(String(Object.values(row)[0] ?? "")));
  }

  const { rows } = await runQuery(info, WRITE_CHECKS[info.engine], [], limits);

  return rows.map((row) => String(row.ability));
}

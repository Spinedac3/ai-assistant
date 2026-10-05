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
  // Zone in which Postgres reads and shows the dates that carry one; the session's otherwise
  timeZone?: string;
}

// What a column holds, read from the engine's own type and not from the values
export type ColumnKind = "number" | "text" | "date" | "datetime" | "boolean";

export interface QueryResult {
  columns: string[];
  rows: Array<Record<string, unknown>>;
  kinds: Record<string, ColumnKind>;
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

// Type ids of each engine by kind; anything else is text
const PG_KINDS: Record<number, ColumnKind> = {
  20: "number",
  21: "number",
  23: "number",
  700: "number",
  701: "number",
  1700: "number",
  16: "boolean",
  1082: "date",
  1114: "datetime",
  1184: "datetime",
};
const MYSQL_KINDS: Record<number, ColumnKind> = {
  0: "number",
  1: "number",
  2: "number",
  3: "number",
  4: "number",
  5: "number",
  8: "number",
  9: "number",
  13: "number",
  246: "number",
  10: "date",
  14: "date",
  7: "datetime",
  12: "datetime",
};
interface MysqlField {
  name: string;
  type?: number;
  columnType?: number;
  columnLength?: number;
}

const MSSQL_KINDS: Record<string, ColumnKind> = {
  int: "number",
  bigint: "number",
  smallint: "number",
  tinyint: "number",
  float: "number",
  real: "number",
  decimal: "number",
  numeric: "number",
  money: "number",
  smallmoney: "number",
  bit: "boolean",
  date: "date",
  datetime: "datetime",
  datetime2: "datetime",
  smalldatetime: "datetime",
  datetimeoffset: "datetime",
};

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
    if (limits.timeZone) {
      await client.query("SELECT set_config('TimeZone', $1, true)", [limits.timeZone]);
    }
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];
    let kinds: Record<string, ColumnKind> = {};
    const readFields = (fields: pg.FieldDef[]) => {
      columns = fields.map((field) => field.name);
      kinds = Object.fromEntries(
        fields.map((field) => [field.name, PG_KINDS[field.dataTypeID] ?? "text"]),
      );
    };

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
          readFields(result.fields);
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
        if (columns.length === 0) {
          readFields(result.fields);
        }
        resolve();
      });
      query.on("error", reject);
    });

    await client.query("ROLLBACK");
    checkColumns(columns);

    return { columns, rows, kinds };
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
    let kinds: Record<string, ColumnKind> = {};

    await new Promise<void>((resolve, reject) => {
      let stopped = false;
      connection
        .query({ sql, values: params, timeout: limits.timeoutMs })
        // Statements that return no rows come without fields
        .on("fields", (fields?: MysqlField[]) => {
          columns = (fields ?? []).map((field) => field.name);
          kinds = Object.fromEntries(
            (fields ?? []).map((field) => {
              const type = field.type ?? field.columnType ?? -1;
              // MySQL stores a boolean as a one-digit tinyint or a one-bit field
              return [
                field.name,
                (type === 1 || type === 16) && field.columnLength === 1
                  ? "boolean"
                  : (MYSQL_KINDS[type] ?? "text"),
              ];
            }),
          );
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

    return { columns, rows, kinds };
  } finally {
    connection.destroy();
  }
}

/**
 * Runs a query on SQL Server; it has no read-only transaction, so the read-only user, checked
 * when the source is registered, is the barrier. The query also runs in a transaction rolled back
 * at the end, a second line only: a batch can commit it
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
    // Dates in YYYY-MM-DD read the same whatever language the login has
    await new mssql.Request(transaction).query("SET XACT_ABORT ON; SET DATEFORMAT ymd");
    const request = new mssql.Request(transaction);
    request.stream = true;
    for (const [position, value] of params.entries()) {
      request.input(`p${position + 1}`, value);
    }
    const rows: Array<Record<string, unknown>> = [];
    let columns: string[] = [];
    let kinds: Record<string, ColumnKind> = {};

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
        kinds = Object.fromEntries(
          Object.entries(meta).map(([name, column]) => {
            const type = (column as { type?: { declaration?: string } }).type;
            return [name, MSSQL_KINDS[type?.declaration ?? ""] ?? "text"];
          }),
        );
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

    return { columns, rows, kinds };
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    await transaction.rollback().catch(() => {});
    await pool.close().catch(() => {});
  }
}

/**
 * Tells whether a statement is a read: SELECT or WITH, after any comments and parentheses
 *
 * @param   sql  Statement
 *
 * @return  Whether it starts as a read
 */
export function startsAsRead(sql: string): boolean {
  // MySQL runs the inside of /*! … */ as code, so it never counts as a comment
  if (sql.includes("/*!")) {
    return false;
  }

  // Postgres ends a line comment at \r too and nests block comments, so a block comment holding
  // another opening is not skipped: the statement then fails as not a read
  const start = sql.replace(/^(\s|\(|--[^\r\n]*([\r\n]|$)|\/\*((?!\/\*)[\s\S])*?\*\/)*/, "");

  return /^(select|with)\b/i.test(start);
}

/**
 * Runs a read-only query on a source
 *
 * Postgres and MySQL take one statement per query, so refusing anything that does not start as
 * a read keeps out every statement that commits on its own: a password change, a GRANT, a DO
 * that the server timeout would not stop. SQL Server takes batches, so there the read-only user,
 * checked when the source is registered, is the barrier.
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
  if (info.engine !== "mssql" && !startsAsRead(sql)) {
    return Promise.reject(new Error("Solo se ejecutan consultas de lectura (SELECT o WITH)"));
  }

  return execute(info, sql, params, limits);
}

/**
 * Runs a statement on its engine, with no check of what it is
 *
 * @param   info    Connection
 * @param   sql     Statement
 * @param   params  Values
 * @param   limits  Timeout and rows
 *
 * @return  Columns and rows
 */
function execute(
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
/**
 * Postgres check for membership in a built-in role that older servers may not have; CASE,
 * unlike AND, is sure to skip the lookup of a missing role
 *
 * @param   role  Role name
 *
 * @return  SQL boolean expression
 */
function memberOf(role: string): string {
  return `case when to_regrole('${role}') is not null
    then pg_has_role(current_user, '${role}', 'MEMBER') else false end`;
}

/**
 * Postgres check for the right to run a function that reaches the server's files, granted on
 * its own without the file roles; the function may not exist on every server
 *
 * @param   signature  Function signature
 *
 * @return  SQL boolean expression
 */
function canRun(signature: string): string {
  return `case when to_regprocedure('${signature}') is not null
    then has_function_privilege('${signature}', 'EXECUTE') else false end`;
}

const WRITE_CHECKS: Record<"postgres" | "mssql", string> = {
  postgres: `
    select ability from (values
      ('superuser', (select rolsuper from pg_roles where rolname = current_user)),
      ('create_roles', (select rolcreaterole from pg_roles where rolname = current_user)),
      ('create_databases', (select rolcreatedb from pg_roles where rolname = current_user)),
      ('replication', (select rolreplication from pg_roles where rolname = current_user)),
      ('create_schemas', has_database_privilege(current_database(), 'CREATE')),
      ('run_server_programs', ${memberOf("pg_execute_server_program")}),
      ('write_server_files', ${memberOf("pg_write_server_files")}),
      ('read_server_files', ${memberOf("pg_read_server_files")}),
      ('signal_backends', ${memberOf("pg_signal_backend")}),
      ('maintain_tables', ${memberOf("pg_maintain")}),
      ('export_large_objects', ${canRun("lo_export(oid,text)")}),
      ('write_files', ${canRun("pg_file_write(text,text,boolean)")}),
      ('read_files', ${canRun("pg_read_file(text)")}),
      ('read_binary_files', ${canRun("pg_read_binary_file(text)")}),
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
    where permission_name not in ('CONNECT SQL', 'CONNECT ANY DATABASE', 'SELECT ALL USER SECURABLES')
      and permission_name not like 'VIEW %'
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
      and p.permission_name in ('IMPERSONATE', 'CONTROL', 'ALTER', 'TAKE OWNERSHIP')
    union
    select ('role ' + d.name + ' ' + p.permission_name) collate database_default
    from sys.database_principals d cross apply fn_my_permissions(quotename(d.name), 'ROLE') p
    where d.type = 'R' and is_rolemember(d.name) = 0
      and p.permission_name in ('ALTER', 'CONTROL', 'TAKE OWNERSHIP')
    union
    select ('login ' + l.name + ' ' + p.permission_name) collate database_default
    from sys.server_principals l
    cross apply fn_my_permissions(quotename(l.name), case when l.type = 'R' then 'SERVER ROLE' else 'LOGIN' end) p
    where l.type in ('S', 'U', 'G', 'R', 'E', 'X') and l.name <> suser_name()
      and p.permission_name in ('IMPERSONATE', 'CONTROL', 'ALTER', 'TAKE OWNERSHIP')`,
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

  const passOn = /WITH GRANT OPTION/i.test(grant) ? ["GRANT OPTION"] : [];

  // Column grants carry their own commas, as in SELECT (a, b)
  return [
    ...passOn,
    ...privileges
      .replace(/\([^)]*\)/g, "")
      .split(",")
      .map((privilege) => privilege.trim().toUpperCase())
      .filter((privilege) => privilege !== "" && !MYSQL_READS.has(privilege)),
  ];
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
    const { rows } = await execute(info, "SHOW GRANTS FOR CURRENT_USER()", [], limits);
    return rows.flatMap((row) => mysqlWrites(String(Object.values(row)[0] ?? "")));
  }

  const { rows } = await execute(info, WRITE_CHECKS[info.engine], [], limits);

  return rows.map((row) => String(row.ability));
}

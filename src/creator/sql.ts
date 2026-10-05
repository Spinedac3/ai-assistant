import type { EngineName } from "../sources/engines.js";
import type { ToolDefinitionSpec } from "./definition.js";

export interface BuiltQuery {
  sql: string;
  params: unknown[];
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Names the parameter of a filter after its column, as the model can write it
 *
 * @param   column  Column as the source names it
 *
 * @return  Lowercase name with letters, digits and underscores
 */
export function paramName(column: string): string {
  const plain = column
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

  return /^[a-z]/.test(plain) ? plain : `c_${plain}`;
}

/**
 * Quotes a name as the engine reads it; the definition already refused names with quote marks
 *
 * @param   name    Column or relation part
 * @param   engine  Engine
 *
 * @return  The quoted name
 */
function quote(name: string, engine: EngineName): string {
  return engine === "mysql" ? `\`${name}\`` : engine === "mssql" ? `[${name}]` : `"${name}"`;
}

/**
 * Moves a bare date one day forward, so a range ending on that day keeps the hours of that day
 *
 * @param   date  Date as YYYY-MM-DD
 *
 * @return  The next day as YYYY-MM-DD
 */
function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);

  return day.toISOString().slice(0, 10);
}

/**
 * Builds the query of a tool for one call: the base wrapped, the filters given, the summary and
 * the order, with the values as parameters and never as text
 *
 * @param   spec    Tool definition
 * @param   engine  Engine of the source
 * @param   base    Checked pasted query, when the base is one
 * @param   args    Filter values by parameter name; absent optional filters are left out
 *
 * @return  The query and its parameters
 */
export function buildQuery(
  spec: ToolDefinitionSpec,
  engine: EngineName,
  base: string | null,
  args: Record<string, unknown>,
): BuiltQuery {
  const params: unknown[] = [];
  const bind = (value: unknown) => {
    params.push(value);
    return engine === "postgres"
      ? `$${params.length}`
      : engine === "mysql"
        ? "?"
        : `@p${params.length}`;
  };
  const text = engine === "postgres" ? "text" : engine === "mysql" ? "char" : "nvarchar(max)";

  // A pasted query may end in a line comment, so the closing parenthesis goes on its own line
  const from =
    spec.base.kind === "table"
      ? spec.base.name
          .split(".")
          .map((part) => quote(part, engine))
          .join(".")
      : `(\n${base ?? spec.base.sql}\n)`;

  const conditions: string[] = [];
  for (const filter of spec.filters) {
    const value = args[paramName(filter.column)];
    if (value === undefined) {
      continue;
    }

    const column = quote(filter.column, engine);
    // A bare date stands for the whole day, whatever hour the column holds
    const day = typeof value === "string" && DATE_ONLY.test(value);
    switch (filter.op) {
      case "=":
        conditions.push(
          day
            ? `${column} >= ${bind(value)} AND ${column} < ${bind(nextDay(value as string))}`
            : `${column} = ${bind(value)}`,
        );
        break;
      case "!=":
        conditions.push(
          day
            ? `(${column} < ${bind(value)} OR ${column} >= ${bind(nextDay(value as string))})`
            : `${column} <> ${bind(value)}`,
        );
        break;
      case ">":
        conditions.push(
          day ? `${column} >= ${bind(nextDay(value as string))}` : `${column} > ${bind(value)}`,
        );
        break;
      case "<=":
        conditions.push(
          day ? `${column} < ${bind(nextDay(value as string))}` : `${column} <= ${bind(value)}`,
        );
        break;
      case ">=":
      case "<":
        conditions.push(`${column} ${filter.op} ${bind(value)}`);
        break;
      case "between": {
        const [low, high] = value as [unknown, unknown];
        const lastDay = typeof high === "string" && DATE_ONLY.test(high);
        conditions.push(
          lastDay
            ? `${column} >= ${bind(low)} AND ${column} < ${bind(nextDay(high))}`
            : `${column} BETWEEN ${bind(low)} AND ${bind(high)}`,
        );
        break;
      }
      case "in":
        conditions.push(`${column} IN (${(value as unknown[]).map(bind).join(", ")})`);
        break;
      case "contains": {
        // The value is searched as written: its own % and _ match themselves
        const escaped = String(value).replace(/[\\%_]/g, (char) => `\\${char}`);
        const like = engine === "postgres" ? "ILIKE" : "LIKE";
        // MySQL reads a backslash inside a string as an escape, so it writes the backslash twice
        const escapeMark = engine === "mysql" ? "'\\\\'" : "'\\'";
        conditions.push(
          `CAST(${column} AS ${text}) ${like} ${bind(`%${escaped}%`)} ESCAPE ${escapeMark}`,
        );
        break;
      }
      case "empty":
        conditions.push(value === true ? `${column} IS NULL` : `${column} IS NOT NULL`);
        break;
    }
  }

  const summary = spec.summary;
  const select = summary
    ? [
        ...summary.group_by.map((column) => quote(column, engine)),
        ...summary.aggregates.map((aggregate) => {
          const column = aggregate.column ? quote(aggregate.column, engine) : "*";
          // An average of whole numbers would be cut to a whole number in SQL Server
          const expression =
            aggregate.fn === "avg"
              ? `AVG(CAST(${column} AS DECIMAL(38, 6)))`
              : `${aggregate.fn.toUpperCase()}(${column})`;
          return `${expression} AS ${quote(aggregate.as, engine)}`;
        }),
      ]
    : spec.columns.map((column) => quote(column.name, engine));

  const lines = [`SELECT ${select.join(", ")}`, `FROM ${from} AS base`];
  if (conditions.length > 0) {
    lines.push(`WHERE ${conditions.join(" AND ")}`);
  }
  if (summary && summary.group_by.length > 0) {
    lines.push(`GROUP BY ${summary.group_by.map((column) => quote(column, engine)).join(", ")}`);
  }
  if (spec.order_by.length > 0) {
    lines.push(
      `ORDER BY ${spec.order_by.map((order) => `${quote(order.column, engine)} ${order.direction.toUpperCase()}`).join(", ")}`,
    );
  }

  return { sql: lines.join("\n"), params };
}

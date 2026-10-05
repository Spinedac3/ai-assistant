import {
  type ColumnKind,
  type ConnectionInfo,
  type QueryLimits,
  type QueryResult,
  runQuery,
} from "../sources/engines.js";
import type { ToolDefinitionSpec } from "./definition.js";
import { fromClause } from "./sql.js";

export interface BaseColumn {
  name: string;
  kind: ColumnKind;
}

/**
 * Lists the columns of a tool's base and what each holds, reading no rows
 *
 * @param   info    Connection of the source
 * @param   base    Base of the definition
 * @param   pasted  Checked pasted query, when the base is one
 * @param   limits  Timeout of the source
 *
 * @return  The columns in order
 */
export async function describeBase(
  info: ConnectionInfo,
  base: ToolDefinitionSpec["base"],
  pasted: string | null,
  limits: QueryLimits,
): Promise<BaseColumn[]> {
  const from = fromClause(base, info.engine, pasted);
  const result = await runQuery(info, `SELECT * FROM ${from} AS base WHERE 1 = 0`, [], limits);

  return result.columns.map((name) => ({ name, kind: result.kinds[name] ?? "text" }));
}

/**
 * Gives every engine's rows the same shape: numbers as numbers and booleans as booleans, while
 * dates stay as the naive text the source wrote
 *
 * @param   result  Rows and the kind of each column
 *
 * @return  The rows
 */
export function normalizeRows(result: QueryResult): Array<Record<string, unknown>> {
  const numeric = result.columns.filter((column) => result.kinds[column] === "number");
  const flags = result.columns.filter((column) => result.kinds[column] === "boolean");
  if (numeric.length === 0 && flags.length === 0) {
    return result.rows;
  }

  return result.rows.map((row) => {
    const copy = { ...row };
    // Postgres and MySQL give decimals and big integers as exact text
    for (const column of numeric) {
      if (typeof copy[column] === "string" || typeof copy[column] === "bigint") {
        copy[column] = Number(copy[column]);
      }
    }
    // MySQL gives a one-bit field as a one-byte buffer
    for (const column of flags) {
      const value = copy[column];
      if (typeof value === "number") {
        copy[column] = value !== 0;
      } else if (Buffer.isBuffer(value)) {
        copy[column] = value[0] !== 0;
      }
    }
    return copy;
  });
}

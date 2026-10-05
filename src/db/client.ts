import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema.js";

export type Database = NodePgDatabase<typeof schema>;

export interface DatabaseHandle {
  db: Database;
  close: () => Promise<void>;
}

/**
 * Opens a connection pool to the own database
 *
 * @param   url  Postgres connection string
 *
 * @return  The query builder and a way to release the pool
 */
export function connectDatabase(url: string): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url });

  return {
    db: drizzle(pool, { schema }),
    close: () => pool.end(),
  };
}

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";
import { connectDatabase, type DatabaseHandle } from "../../../src/db/client.js";
import { seedBase } from "../../../src/db/seed.js";

const TEST_URL =
  process.env.TEST_DATABASE_URL ?? "postgres://assistant:assistant@localhost:5432/assistant_test";

/**
 * Creates the test database when the server does not have it yet
 */
async function ensureDatabase(): Promise<void> {
  const target = new URL(TEST_URL);
  const name = target.pathname.slice(1);
  const admin = new URL(TEST_URL);
  admin.pathname = "/postgres";

  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const exists = await client.query("select 1 from pg_database where datname = $1", [name]);
    if (exists.rowCount === 0) {
      await client.query(`create database "${name}"`);
    }
  } finally {
    await client.end();
  }
}

/**
 * Gives a test an empty, migrated and seeded database
 *
 * @return  The database handle
 */
export async function freshDatabase(): Promise<DatabaseHandle> {
  await ensureDatabase();

  const handle = connectDatabase(TEST_URL);
  await handle.db.execute(sql`drop schema if exists public cascade`);
  await handle.db.execute(sql`drop schema if exists drizzle cascade`);
  await handle.db.execute(sql`create schema public`);
  await migrate(handle.db, { migrationsFolder: "./src/db/migrations" });
  await seedBase(handle.db);

  return handle;
}

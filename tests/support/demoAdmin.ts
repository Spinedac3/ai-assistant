import mssql from "mssql";
import mysql from "mysql2/promise";
import pg from "pg";
import { DEMO_ENGINES } from "../../src/cli/demoEngines.js";
import type { EngineName } from "../../src/sources/engines.js";

/**
 * Runs statements as the administrator of a demo engine, to set up users a test needs
 *
 * @param   engine      Engine
 * @param   statements  Statements, one by one
 */
export async function asDemoAdmin(engine: EngineName, statements: string[]): Promise<void> {
  const { admin } = DEMO_ENGINES[engine];

  if (engine === "postgres") {
    const client = new pg.Client({
      host: admin.host,
      port: admin.port,
      user: admin.username,
      password: admin.password,
      database: admin.database,
    });
    await client.connect();
    try {
      for (const statement of statements) {
        await client.query(statement);
      }
    } finally {
      await client.end();
    }
    return;
  }

  if (engine === "mysql") {
    const connection = await mysql.createConnection({
      host: admin.host,
      port: admin.port,
      user: admin.username,
      password: admin.password,
      database: admin.database,
    });
    try {
      for (const statement of statements) {
        await connection.query(statement);
      }
    } finally {
      await connection.end();
    }
    return;
  }

  const pool = await new mssql.ConnectionPool({
    server: admin.host,
    port: admin.port,
    user: admin.username,
    password: admin.password,
    database: admin.database,
    options: { encrypt: false, trustServerCertificate: true },
  }).connect();
  try {
    for (const statement of statements) {
      await pool.request().query(statement);
    }
  } finally {
    await pool.close();
  }
}

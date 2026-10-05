import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { roles, sources, users } from "../../src/db/schema.js";
import {
  type ConnectionInfo,
  type EngineName,
  runQuery,
  TooManyRowsError,
} from "../../src/sources/engines.js";
import { connectionFor } from "../../src/sources/registry.js";
import { Secrets } from "../../src/vault/envelope.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const PASSWORD = "tres caballos verdes";
const LIMITS = { timeoutMs: 10_000, maxRows: 10_000 };

// The demo engines of docker-compose, seeded with `pnpm demo:seed`
const DEMO: Record<EngineName, { reader: ConnectionInfo; admin: ConnectionInfo; param: string }> = {
  postgres: {
    reader: {
      engine: "postgres",
      host: "localhost",
      port: 5433,
      database: "demo",
      username: "demo_reader",
      password: "demo-reader",
      tls: false,
    },
    admin: {
      engine: "postgres",
      host: "localhost",
      port: 5433,
      database: "demo",
      username: "demo",
      password: "demo",
      tls: false,
    },
    param: "$1",
  },
  mysql: {
    reader: {
      engine: "mysql",
      host: "localhost",
      port: 3307,
      database: "demo",
      username: "demo_reader",
      password: "demo-reader",
      tls: false,
    },
    admin: {
      engine: "mysql",
      host: "localhost",
      port: 3307,
      database: "demo",
      username: "root",
      password: "demo-root",
      tls: false,
    },
    param: "?",
  },
  mssql: {
    reader: {
      engine: "mssql",
      host: "localhost",
      port: 1434,
      database: "demo",
      username: "demo_reader",
      password: "Demo-Reader-2026",
      tls: false,
    },
    admin: {
      engine: "mssql",
      host: "localhost",
      port: 1434,
      database: "demo",
      username: "sa",
      password: "Demo-Root-2026",
      tls: false,
    },
    param: "@p1",
  },
};

/**
 * Tells whether a demo engine is running and seeded; SQL Server is optional on a laptop
 *
 * @param   engine  Engine
 *
 * @return  Whether its reader can query
 */
async function seeded(engine: EngineName): Promise<boolean> {
  try {
    await runQuery(DEMO[engine].reader, "select 1 as uno", [], LIMITS);
    return true;
  } catch {
    return false;
  }
}

const available = (
  await Promise.all(
    (Object.keys(DEMO) as EngineName[]).map(async (engine) =>
      (await seeded(engine)) ? engine : null,
    ),
  )
).filter((engine): engine is EngineName => engine !== null);

let database: DatabaseHandle;
let app: FastifyInstance;
let adminToken: string;
const vault = Secrets.fromKey(randomBytes(32));

/**
 * Registers a source through the administration
 *
 * @param   code  Source code
 * @param   info  Connection
 * @param   token  Bearer token
 *
 * @return  The response
 */
function register(code: string, info: ConnectionInfo, token = adminToken) {
  return app.inject({
    method: "POST",
    url: "/admin/sources",
    headers: { authorization: `Bearer ${token}` },
    payload: { code, name: `Demo ${info.engine}`, ...info, timeZone: "America/Guatemala" },
  });
}

describe("sources", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    for (const [email, role] of [
      ["admin@example.com", "admin"],
      ["ana@example.com", "user"],
    ] as const) {
      const [row] = await database.db.select().from(roles).where(eq(roles.code, role));
      await database.db.insert(users).values({
        email,
        displayName: email,
        passwordHash: await hashPassword(PASSWORD),
        primaryRoleId: row?.id ?? null,
      });
    }

    app = await buildApp({
      db: database.db,
      signer: testSigner(),
      systems: new Map(),
      sources: { secrets: vault },
    });
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "admin@example.com", password: PASSWORD },
    });
    adminToken = login.json().data.token;
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("has at least Postgres and MySQL to test against", () => {
    // Performs assertions.
    expect(available).toEqual(expect.arrayContaining(["postgres", "mysql"]));
  });

  it("registers a read-only source on every engine and seals its password", async () => {
    // Performs the test.
    const responses = [];
    for (const engine of available) {
      responses.push((await register(`demo-${engine}`, DEMO[engine].reader)).statusCode);
    }
    const stored = await database.db.select().from(sources);
    const listed = await app.inject({
      url: "/admin/sources",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const opened = await connectionFor(database.db, vault, "demo-postgres");

    // Performs assertions.
    expect(responses.every((status) => status === 201)).toBe(true);
    expect(
      stored.every((row) => !row.sealedPassword.includes(DEMO[row.engine].reader.password)),
    ).toBe(true);
    expect(JSON.stringify(listed.json())).not.toContain("demo-reader");
    expect(JSON.stringify(listed.json())).not.toContain("sealed");
    expect(opened?.info.password).toBe("demo-reader");
    expect(opened?.timeZone).toBe("America/Guatemala");
  });

  it("refuses a user that can write, naming what it can do", async () => {
    // Performs the test.
    const outcomes = [];
    for (const engine of available) {
      outcomes.push((await register(`admin-${engine}`, DEMO[engine].admin)).json());
    }

    // Performs assertions.
    for (const outcome of outcomes) {
      expect(outcome.error).toBe("not_read_only");
      expect(outcome.abilities.length).toBeGreaterThan(0);
    }
  });

  it("reports a failed connection without echoing the password", async () => {
    // Performs the test.
    const response = await register("mala", {
      ...DEMO.postgres.reader,
      password: "clave-equivocada-123",
    });

    // Performs assertions.
    expect(response.json().error).toBe("connection_failed");
    expect(response.body).not.toContain("clave-equivocada-123");
  });

  it("lets only sources.manage administer sources", async () => {
    // Performs the test.
    const login = await app.inject({
      method: "POST",
      url: "/auth/login",
      payload: { email: "ana@example.com", password: PASSWORD },
    });
    const response = await register("intruso", DEMO.postgres.reader, login.json().data.token);

    // Performs assertions.
    expect(response.statusCode).toBe(403);
  });

  it("tests and deletes a registered source", async () => {
    // Performs the test.
    const headers = { authorization: `Bearer ${adminToken}` };
    await register("borrar", DEMO.postgres.reader);
    const tested = await app.inject({ method: "POST", url: "/admin/sources/borrar/test", headers });
    const deleted = await app.inject({ method: "DELETE", url: "/admin/sources/borrar", headers });
    const again = await app.inject({ method: "DELETE", url: "/admin/sources/borrar", headers });

    // Performs assertions.
    expect(tested.json().data).toEqual({ ok: true });
    expect(deleted.statusCode).toBe(200);
    expect(again.statusCode).toBe(404);
  });

  it("returns the same rows on every engine, dates as written and amounts exact", async () => {
    // Performs the test.
    const results = await Promise.all(
      available.map((engine) =>
        runQuery(
          DEMO[engine].reader,
          `select id, fecha, total from pedidos where id <= ${DEMO[engine].param} order by id`,
          [3],
          LIMITS,
        ),
      ),
    );
    const normalized = results.map((result) =>
      result.rows.map((row) => [row.id, row.fecha, Number(row.total).toFixed(2)]),
    );

    // Performs assertions.
    expect(results[0]?.columns).toEqual(["id", "fecha", "total"]);
    for (const rows of normalized) {
      expect(rows).toEqual(normalized[0]);
    }
    expect(normalized[0]?.[0]?.[1]).toMatch(/^2026-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("stops a query past the row limit instead of loading it whole", async () => {
    // Performs the test.
    const attempts = await Promise.allSettled(
      available.map((engine) =>
        runQuery(DEMO[engine].reader, "select * from pedido_detalle", [], {
          timeoutMs: 10_000,
          maxRows: 100,
        }),
      ),
    );

    // Performs assertions.
    for (const attempt of attempts) {
      expect(attempt.status === "rejected" && attempt.reason instanceof TooManyRowsError).toBe(
        true,
      );
    }
  });

  it("refuses to write even with a user that could, where the engine allows a read-only transaction", async () => {
    // Performs the test.
    const attempts = await Promise.allSettled(
      (["postgres", "mysql"] as const)
        .filter((engine) => available.includes(engine))
        .map((engine) => runQuery(DEMO[engine].admin, "delete from entregas", [], LIMITS)),
    );
    const left = await runQuery(
      DEMO.postgres.reader,
      "select count(*) as n from entregas",
      [],
      LIMITS,
    );

    // Performs assertions.
    expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true);
    expect(Number(left.rows[0]?.n)).toBeGreaterThan(0);
  });

  it("cuts a query that runs past its time", async () => {
    // Performs the test.
    const slow = runQuery(DEMO.postgres.reader, "select pg_sleep(3)", [], {
      timeoutMs: 500,
      maxRows: 10,
    });

    // Performs assertions.
    await expect(slow).rejects.toThrow(/timeout|cancel/i);
  });
});

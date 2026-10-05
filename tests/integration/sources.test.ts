import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { hashPassword } from "../../src/auth/password.js";
import { DEMO_ENGINES } from "../../src/cli/demoEngines.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { roles, sources, users } from "../../src/db/schema.js";
import {
  type ConnectionInfo,
  type EngineName,
  runQuery,
  TooManyRowsError,
  writeAbilities,
} from "../../src/sources/engines.js";
import { connectionFor } from "../../src/sources/registry.js";
import { Secrets } from "../../src/vault/envelope.js";
import { asDemoAdmin } from "../support/demoAdmin.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const PASSWORD = "tres caballos verdes";
const LIMITS = { timeoutMs: 10_000, maxRows: 10_000 };

// The demo engines of docker-compose, seeded with `pnpm demo:seed`
const DEMO = DEMO_ENGINES;

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

  it("has the engines to test against: all three in CI, SQL Server optional on a laptop", () => {
    // Performs assertions.
    expect(available).toEqual(
      expect.arrayContaining(
        process.env.CI === "true" ? ["postgres", "mysql", "mssql"] : ["postgres", "mysql"],
      ),
    );
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

  it("cuts a slow query on every engine", async () => {
    // Performs the test.
    const slow: Record<EngineName, string> = {
      postgres: "select pg_sleep(3)",
      mysql: "select sleep(3) as s from productos",
      mssql: "waitfor delay '00:00:03'; select 1 as uno",
    };
    const started = Date.now();
    const attempts = await Promise.allSettled(
      available.map((engine) =>
        runQuery(DEMO[engine].reader, slow[engine], [], { timeoutMs: 500, maxRows: 100 }),
      ),
    );

    // Performs assertions.
    expect(attempts.every((attempt) => attempt.status === "rejected")).toBe(true);
    expect(Date.now() - started).toBeLessThan(2_500);
  });

  it("refuses users that can write in ways short of being administrators", async () => {
    // Performs the test.
    const found: Record<string, string[]> = {};
    await asDemoAdmin("postgres", [
      "drop role if exists w_insert",
      "drop role if exists w_column",
      "drop role if exists w_program",
      "create role w_insert login password 'w-pass'",
      "create role w_column login password 'w-pass'",
      "create role w_program login password 'w-pass'",
      "grant select on all tables in schema public to w_insert, w_column, w_program",
      "grant insert on entregas to w_insert",
      "grant update (piloto) on entregas to w_column",
      "grant pg_execute_server_program to w_program",
    ]);
    for (const user of ["w_insert", "w_column", "w_program"]) {
      found[user] = await writeAbilities({
        ...DEMO.postgres.reader,
        username: user,
        password: "w-pass",
      });
    }
    await asDemoAdmin("postgres", [
      "drop owned by w_insert, w_column, w_program",
      "drop role w_insert",
      "drop role w_column",
      "drop role w_program",
    ]);

    await asDemoAdmin("mysql", [
      "drop user if exists 'w_insert'@'%'",
      "drop user if exists 'w_vars'@'%'",
      "create user 'w_insert'@'%' identified by 'w-pass'",
      "create user 'w_vars'@'%' identified by 'w-pass'",
      "grant select on demo.* to 'w_insert'@'%', 'w_vars'@'%'",
      "grant insert on demo.entregas to 'w_insert'@'%'",
      "grant system_variables_admin on *.* to 'w_vars'@'%'",
    ]);
    for (const user of ["w_insert", "w_vars"]) {
      found[`mysql ${user}`] = await writeAbilities({
        ...DEMO.mysql.reader,
        username: user,
        password: "w-pass",
      });
    }
    await asDemoAdmin("mysql", ["drop user 'w_insert'@'%'", "drop user 'w_vars'@'%'"]);

    if (available.includes("mssql")) {
      await asDemoAdmin("mssql", [
        "if exists (select 1 from sys.database_principals where name = 'w_exec') drop user w_exec",
        "if exists (select 1 from sys.server_principals where name = 'w_exec') drop login w_exec",
        "create login w_exec with password = 'W-Pass-2026-x'",
        "create user w_exec for login w_exec",
        "alter role db_datareader add member w_exec",
        "create or alter procedure dbo.marcar as update entregas set a_tiempo = a_tiempo where 1 = 0",
        "grant execute on dbo.marcar to w_exec",
      ]);
      found["mssql w_exec"] = await writeAbilities({
        ...DEMO.mssql.reader,
        username: "w_exec",
        password: "W-Pass-2026-x",
      });
      await asDemoAdmin("mssql", [
        "drop user w_exec",
        "drop login w_exec",
        "drop procedure dbo.marcar",
      ]);
    }

    // Performs assertions.
    expect(found.w_insert).toContain("write_rows");
    expect(found.w_column).toContain("write_rows");
    expect(found.w_program).toContain("run_server_programs");
    expect(found["mysql w_insert"]).toEqual(["INSERT"]);
    expect(found["mysql w_vars"]).toContain("SYSTEM_VARIABLES_ADMIN");
    if (available.includes("mssql")) {
      expect(found["mssql w_exec"]).toContain("object dbo.marcar EXECUTE");
    }
  });

  it("refuses SQL Server users that can join a writing role or act as another login", async () => {
    // Performs the test.
    if (!available.includes("mssql")) {
      return;
    }
    const user = (name: string) => ({
      ...DEMO.mssql.reader,
      username: name,
      password: "W-Pass-2026-x",
    });
    const reader = (name: string) => [
      `if exists (select 1 from sys.database_principals where name = '${name}') drop user ${name}`,
      `if exists (select 1 from sys.server_principals where name = '${name}') drop login ${name}`,
      `create login ${name} with password = 'W-Pass-2026-x'`,
      `create user ${name} for login ${name}`,
      `alter role db_datareader add member ${name}`,
    ];
    await asDemoAdmin("mssql", [
      ...reader("zz_role"),
      ...reader("zz_imp"),
      ...reader("zz_wide"),
      "if exists (select 1 from sys.database_principals where name = 'zz_w') drop role zz_w",
      "create role zz_w",
      "grant insert on entregas to zz_w",
      "grant alter on role::zz_w to zz_role",
      "if exists (select 1 from sys.server_principals where name = 'zz_t') drop login zz_t",
      "create login zz_t with password = 'W-Pass-2026-x'",
      "use master; grant impersonate on login::zz_t to zz_imp",
      "use master; grant connect any database to zz_wide",
      "use master; grant select all user securables to zz_wide",
    ]);
    const found = {
      role: await writeAbilities(user("zz_role")),
      impersonate: await writeAbilities(user("zz_imp")),
      wide: await writeAbilities(user("zz_wide")),
    };
    await asDemoAdmin("mssql", [
      "drop user zz_role",
      "drop user zz_imp",
      "drop user zz_wide",
      "drop role zz_w",
      "drop login zz_role",
      "drop login zz_imp",
      "drop login zz_wide",
      "drop login zz_t",
    ]);

    // Performs assertions.
    expect(found.role).toContain("role zz_w ALTER");
    expect(found.impersonate).toContain("login zz_t IMPERSONATE");
    expect(found.wide).toEqual([]);
  });

  it("runs one statement only, so no text can end the read-only transaction", async () => {
    // Performs the test.
    // A table of its own: a failure here must never cost the demo data
    for (const engine of ["postgres", "mysql"] as const) {
      await asDemoAdmin(engine, [
        "drop table if exists zz_guarda",
        "create table zz_guarda (id int)",
        "insert into zz_guarda values (1)",
      ]);
    }
    const outcomes = await Promise.allSettled([
      runQuery(DEMO.postgres.admin, "select 1; delete from zz_guarda", [], LIMITS),
      runQuery(DEMO.mysql.admin, "select 1; delete from zz_guarda", [], LIMITS),
    ]);
    const left = await Promise.all(
      (["postgres", "mysql"] as const).map((engine) =>
        runQuery(DEMO[engine].admin, "select count(*) as n from zz_guarda", [], LIMITS),
      ),
    );
    for (const engine of ["postgres", "mysql"] as const) {
      await asDemoAdmin(engine, ["drop table zz_guarda"]);
    }

    // Performs assertions.
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["rejected", "rejected"]);
    expect(left.map((result) => Number(result.rows[0]?.n))).toEqual([1, 1]);
  });

  it("refuses anything that does not start as a read on Postgres and MySQL", async () => {
    // Performs the test.
    const attempts = await Promise.allSettled([
      runQuery(
        DEMO.mysql.reader,
        "alter user current_user() identified by 'otra-clave'",
        [],
        LIMITS,
      ),
      runQuery(
        DEMO.mysql.reader,
        "/*!50000 alter user current_user() identified by 'x' */ select 1",
        [],
        LIMITS,
      ),
      runQuery(DEMO.mysql.reader, "do sleep(1)", [], LIMITS),
      runQuery(DEMO.postgres.reader, "do $$ begin perform 1; end $$", [], LIMITS),
    ]);
    const stillWorks = await runQuery(DEMO.mysql.reader, "select 1 as uno", [], LIMITS);

    // Performs assertions.
    for (const attempt of attempts) {
      expect(attempt.status === "rejected" && String(attempt.reason.message)).toContain("lectura");
    }
    expect(stillWorks.rows).toHaveLength(1);
  });

  it("refuses a statement without rows instead of crashing the server", async () => {
    // Performs the test.
    const attempt = runQuery(DEMO.mysql.reader, "set @nada = 1", [], LIMITS);

    // Performs assertions.
    await expect(attempt).rejects.toThrow("lectura");
    expect((await runQuery(DEMO.mysql.reader, "select 1 as uno", [], LIMITS)).rows).toHaveLength(1);
  });

  it("refuses repeated columns and more than one result", async () => {
    // Performs the test.
    const repeated = runQuery(DEMO.postgres.reader, "select 1 as a, 2 as a", [], LIMITS);
    const several = available.includes("mssql")
      ? runQuery(DEMO.mssql.reader, "select 1 as a; select 2 as b", [], LIMITS)
      : Promise.reject(new Error("más de un resultado"));

    // Performs assertions.
    await expect(repeated).rejects.toThrow("columnas repetidas");
    await expect(several).rejects.toThrow("más de un resultado");
  });

  it("lets a result of exactly the row limit through", async () => {
    // Performs the test.
    const attempts = await Promise.allSettled(
      available.map((engine) =>
        runQuery(DEMO[engine].reader, "select id from productos", [], {
          timeoutMs: 10_000,
          maxRows: 20,
        }),
      ),
    );

    // Performs assertions.
    for (const attempt of attempts) {
      expect(attempt.status === "fulfilled" && attempt.value.rows.length === 20).toBe(true);
    }
  });

  it("names what failed in a connection without the driver's details", async () => {
    // Performs the test.
    const badPassword = await register("pass", { ...DEMO.postgres.reader, password: "mala-123" });
    const badPort = await register("port", { ...DEMO.postgres.reader, port: 1 });

    // Performs assertions.
    expect(badPassword.json().message).toBe("Usuario o contraseña incorrectos");
    expect(badPort.json().message).toBe("No se pudo alcanzar el servidor de la base");
    expect(badPort.body).not.toContain("127.0.0.1");
  });
});

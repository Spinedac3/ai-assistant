import { describe, expect, it } from "vitest";
import { checkPasted } from "../../src/creator/pasted.js";

/**
 * Checks a query and returns the refusal, failing the test when it passes
 *
 * @param   sql     Query
 * @param   engine  Engine
 *
 * @return  The refusal message
 */
function refusal(sql: string, engine: "postgres" | "mysql" | "mssql" = "postgres"): string {
  const checked = checkPasted(sql, engine);
  if (checked.ok) {
    throw new Error(`Se aceptó: ${sql}`);
  }

  return checked.message;
}

/**
 * Checks a query and returns what would run, failing the test when it is refused
 *
 * @param   sql     Query
 * @param   engine  Engine
 *
 * @return  The query to run
 */
function accepted(sql: string, engine: "postgres" | "mysql" | "mssql" = "postgres"): string {
  const checked = checkPasted(sql, engine);
  if (!checked.ok) {
    throw new Error(checked.message);
  }

  return checked.sql;
}

describe("pasted query", () => {
  it("accepts one read statement, dropping the semicolons around it", () => {
    // Performs assertions.
    expect(accepted("select id, total from pedidos where total > 10;")).toBe(
      "select id, total from pedidos where total > 10",
    );
    expect(accepted(";WITH v AS (SELECT 1 AS n) SELECT * FROM v;")).toBe(
      "WITH v AS (SELECT 1 AS n) SELECT * FROM v",
    );
    expect(accepted("select 'a;--b';", "mysql")).toBe("select 'a;--b'");
    expect(
      accepted(
        "select id, row_number() over (partition by cliente order by fecha) as n from pedidos",
        "mysql",
      ),
    ).toContain("row_number");
  });

  it("runs the query with its comments blanked, so the engine sees only what was checked", () => {
    // Performs the test.
    const blanked = accepted("select 1 /* nota */ as n -- fin\nfrom t");

    // Performs assertions.
    expect(blanked).toBe("select 1            as n       \nfrom t");
  });

  it("refuses what is not one read statement", () => {
    // Performs assertions.
    expect(refusal("delete from pedidos")).toContain("SELECT o WITH");
    expect(refusal("select 1; delete from pedidos")).toContain("una sola consulta");
    expect(refusal("select * into copia from pedidos")).toContain("INTO");
    expect(refusal("select * from pedidos for update")).toContain("bloquear");
    expect(refusal("select * from pedidos for no key update")).toContain("bloquear");
    expect(refusal("select * from pedidos lock in share mode", "mysql")).toContain("bloquear");
    expect(refusal("")).toContain("SELECT o WITH");
  });

  it("refuses a final order, which the creator sets, but keeps orders inside", () => {
    // Performs assertions.
    expect(refusal("select * from pedidos order by fecha")).toContain("ORDER BY");
    expect(
      accepted("select * from (select top 5 * from pedidos order by total desc) as t", "mssql"),
    ).toContain("top 5");
  });

  it("refuses SQL Server table hints, a final OPTION, and a WITH it cannot wrap", () => {
    // Performs assertions.
    expect(refusal("select * from pedidos with (nolock)", "mssql")).toContain("hints");
    expect(refusal("select * from pedidos p (nolock) join clientes c on 1=1", "mssql")).toContain(
      "hints",
    );
    expect(refusal("select * from pedidos option (maxdop 1)", "mssql")).toContain("OPTION");
    expect(refusal("with v as (select 1 as n) select * from v", "mssql")).toContain("subconsulta");
  });

  it("reads comments as each engine nests them, so none can hide the end of the wrapper", () => {
    // Performs the test.
    const breakout =
      "SELECT 1 AS a /* /* */ ' */\n) AS base EXEC master..xp_dirtree '\\\\evil\\x' SELECT (SELECT 1 AS a --'";

    // Performs assertions.
    expect(refusal(breakout, "mssql")).toContain("paréntesis");
    expect(accepted("select 1 /* a /* b */ order by */ from pedidos")).toContain("from pedidos");
    expect(refusal("select 1 /* a /* b */ order by */ from t order by 1")).toContain("ORDER BY");
    expect(refusal("select 1 /*!50000 , sleep(1) */", "mysql")).toContain("/*!");
  });

  it("reads strings and quoted names as each engine does", () => {
    // Performs assertions.
    expect(accepted("select 'order by; delete' as nota from pedidos")).toContain("delete");
    expect(accepted('select "order" from pedidos')).toContain('"order"');
    expect(accepted("select [order by] from pedidos", "mssql")).toContain("[order by]");
    expect(accepted("select 'it\\'s; ok' from pedidos", "mysql")).toContain("ok");
    expect(refusal("select E'\\'' AS a) AS base UNION select 1 --'")).toContain("paréntesis");
    expect(refusal("select $q$'$q$ AS a) AS base UNION select 1 --'")).toContain("paréntesis");
    expect(accepted("select $$ order by $$ as nota from t")).toContain("$$ order by $$");
    expect(refusal("select 1 as a --1 for update", "mysql")).toContain("bloquear");
    expect(refusal("select 'abierto from t")).toContain("sin cerrar");
    expect(refusal("select (1 from t")).toContain("paréntesis");
    expect(refusal("select 1) from t")).toContain("paréntesis");
  });

  it("reads a long query in linear time", () => {
    // Performs the test.
    const started = Date.now();
    const checked = checkPasted(`SELECT 1 /* ;${" ".repeat(200_000)}x */;`, "postgres");

    // Performs assertions.
    expect(checked.ok).toBe(true);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

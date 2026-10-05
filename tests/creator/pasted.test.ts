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

describe("pasted query", () => {
  it("accepts one read statement and drops its closing semicolon", () => {
    // Performs the test.
    const plain = checkPasted("select id, total from pedidos where total > 10;", "postgres");
    const withCte = checkPasted(
      "WITH ventas AS (SELECT cliente_id, SUM(total) AS t FROM pedidos GROUP BY cliente_id)\nSELECT * FROM ventas; -- fin",
      "mssql",
    );
    const windowed = checkPasted(
      "select id, row_number() over (partition by cliente order by fecha) as n from pedidos",
      "mysql",
    );

    // Performs assertions.
    expect(plain).toEqual({ ok: true, sql: "select id, total from pedidos where total > 10" });
    expect(withCte.ok && withCte.sql.endsWith("SELECT * FROM ventas")).toBe(true);
    expect(windowed.ok).toBe(true);
  });

  it("refuses what is not one read statement", () => {
    // Performs assertions.
    expect(refusal("delete from pedidos")).toContain("SELECT o WITH");
    expect(refusal("select 1; delete from pedidos")).toContain("una sola consulta");
    expect(refusal("select * into copia from pedidos")).toContain("INTO");
    expect(refusal("select * from pedidos for update")).toContain("bloquear");
    expect(refusal("select * from pedidos lock in share mode", "mysql")).toContain("bloquear");
    expect(refusal("")).toContain("SELECT o WITH");
  });

  it("refuses a final order, which the creator sets, but keeps orders inside", () => {
    // Performs the test.
    const inside = checkPasted(
      "select * from (select top 5 * from pedidos order by total desc) as t",
      "mssql",
    );

    // Performs assertions.
    expect(refusal("select * from pedidos order by fecha")).toContain("ORDER BY");
    expect(inside.ok).toBe(true);
  });

  it("refuses SQL Server table hints in both forms and a final OPTION", () => {
    // Performs assertions.
    expect(refusal("select * from pedidos with (nolock)", "mssql")).toContain("hints");
    expect(refusal("select * from pedidos p (nolock) join clientes c on 1=1", "mssql")).toContain(
      "hints",
    );
    expect(refusal("select * from pedidos option (maxdop 1)", "mssql")).toContain("OPTION");
  });

  it("reads strings, quoted names and comments as each engine does", () => {
    // Performs the test.
    const inString = checkPasted("select 'order by; delete' as nota from pedidos", "postgres");
    const inName = checkPasted('select "order" from pedidos', "postgres");
    const bracketed = checkPasted("select [order by] from pedidos", "mssql");
    const escaped = checkPasted("select 'it\\'s; ok' from pedidos", "mysql");
    const nested = checkPasted("select 1 /* a /* b */ order by */ from pedidos", "postgres");

    // Performs assertions.
    expect(inString.ok).toBe(true);
    expect(inName.ok).toBe(true);
    expect(bracketed.ok).toBe(true);
    expect(escaped.ok).toBe(true);
    expect(nested.ok).toBe(true);
    expect(refusal("select 1 /* a /* b */ order by */ from t order by 1", "postgres")).toContain(
      "ORDER BY",
    );
    expect(refusal("select 1 /*!50000 , sleep(1) */", "mysql")).toContain("/*!");
    expect(refusal("select 'abierto from t")).toContain("sin cerrar");
    expect(refusal("select (1 from t")).toContain("paréntesis");
    expect(refusal("select 1) from t")).toContain("paréntesis");
  });
});

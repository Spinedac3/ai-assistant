import { describe, expect, it } from "vitest";
import { mysqlWrites, startsAsRead } from "../../src/sources/engines.js";

describe("read guard", () => {
  it("lets through what starts as a read, after comments and parentheses", () => {
    // Performs assertions.
    expect(startsAsRead("select 1")).toBe(true);
    expect(startsAsRead("  WITH t AS (select 1) select * from t")).toBe(true);
    expect(startsAsRead("-- total\n/* por zona */ ( select 1 )")).toBe(true);
    expect(startsAsRead("selectx from t")).toBe(false);
  });

  it("refuses everything else, MySQL versioned comments included", () => {
    // Performs assertions.
    for (const sql of [
      "alter user current_user() identified by 'x'",
      "grant select on demo.* to 'otro'@'%'",
      "do sleep(1)",
      "set @x = 1",
      "/*!50000 alter user current_user() identified by 'x' */ select 1",
      "select 1 /*!50000 , sleep(10) */",
      "",
    ]) {
      expect(startsAsRead(sql)).toBe(false);
    }
  });

  it("counts a grant that can be passed on as a write", () => {
    // Performs assertions.
    expect(mysqlWrites("GRANT SELECT ON `demo`.* TO `lector`@`%` WITH GRANT OPTION")).toEqual([
      "GRANT OPTION",
    ]);
    expect(mysqlWrites("GRANT SELECT (`update`, `create`) ON `demo`.`t` TO `lector`@`%`")).toEqual(
      [],
    );
    expect(mysqlWrites("GRANT `escritor`@`%` TO `lector`@`%`")).toEqual(["role `escritor`@`%`"]);
  });
});

import { describe, expect, it } from "vitest";
import { calculateTool, evaluate, resolveDaysBetween } from "../../src/tools/native/calculate.js";

const context = {
  userId: 1,
  userEmail: "ana@example.com",
  scopes: new Set(["chat.use"]),
  origin: "chat" as const,
  timeZone: "UTC",
};

describe("calculate", () => {
  it("follows the usual precedence and parentheses", () => {
    // Performs assertions.
    expect(evaluate("2 + 3 * 4")).toBe(14);
    expect(evaluate("(2 + 3) * 4")).toBe(20);
    expect(evaluate("-3 + 10 % 4")).toBe(-1);
  });

  it("rounds to the requested decimals", () => {
    // Performs assertions.
    expect(evaluate("round(19.89 / 62.97 * 100, 1)")).toBe(31.6);
  });

  it("refuses anything outside the grammar, so nothing is ever evaluated as code", () => {
    // Performs assertions.
    expect(() => evaluate("process.exit(1)")).toThrow("Carácter no permitido");
    expect(() => evaluate("1 / 0")).toThrow("División entre cero");
  });

  it("counts the days between two dates, today included", () => {
    // Performs the test.
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format(new Date());

    // Performs assertions.
    expect(resolveDaysBetween("days_between(2026-10-05, 2026-09-30)", "UTC")).toBe("5");
    expect(resolveDaysBetween(`days_between(today, ${today})`, "UTC")).toBe("0");
  });

  it("rejects a loose date that would read as chained subtractions", async () => {
    // Performs the test.
    const result = await calculateTool.execute({ expression: "2026-07-30 - 2026-07-29" }, context);

    // Performs assertions.
    expect(result).toEqual(expect.objectContaining({ ok: false, error: "date_in_expression" }));
  });

  it("returns the result with its rounded value and percent for proportions", async () => {
    // Performs the test.
    const result = await calculateTool.execute({ expression: "62.97 / 840.95" }, context);

    // Performs assertions.
    expect(result).toEqual({
      ok: true,
      data: {
        expression: "62.97 / 840.95",
        result: 62.97 / 840.95,
        rounded: 0.07,
        percent: "7.49%",
      },
    });
  });
});

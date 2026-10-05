import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";

describe("app", () => {
  const app = buildApp();

  afterAll(async () => {
    await app.close();
  });

  it("answers the health check", async () => {
    // Performs the test.
    const response = await app.inject({ method: "GET", url: "/health" });

    // Performs assertions.
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok" });
  });
});

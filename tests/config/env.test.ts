import { describe, expect, it } from "vitest";
import { loadEnv } from "../../src/config/env.js";

const required = {
  DATABASE_URL: "postgres://assistant:assistant@localhost:5432/assistant",
  JWT_PRIVATE_KEY_FILE: "secrets/jwt-private.pem",
};

describe("env", () => {
  it("defaults the app time zone to UTC", () => {
    // Performs assertions.
    expect(loadEnv(required).APP_TIMEZONE).toBe("UTC");
  });

  it("accepts an IANA time zone", () => {
    // Performs assertions.
    expect(loadEnv({ ...required, APP_TIMEZONE: "America/Mexico_City" }).APP_TIMEZONE).toBe(
      "America/Mexico_City",
    );
  });

  it("rejects a time zone that does not exist", () => {
    // Performs assertions.
    expect(() => loadEnv({ ...required, APP_TIMEZONE: "Mars/Olympus" })).toThrow(
      "APP_TIMEZONE: Zona horaria IANA desconocida",
    );
  });

  it("fails on a missing database url", () => {
    // Performs assertions.
    expect(() => loadEnv({ JWT_PRIVATE_KEY_FILE: "secrets/jwt-private.pem" })).toThrow(
      "DATABASE_URL",
    );
  });
});

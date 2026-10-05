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

  it("refuses the example storage credentials in production only", () => {
    // Performs the test.
    const production = { ...required, NODE_ENV: "production" };
    const ownKeys = { S3_ACCESS_KEY: "propia", S3_SECRET_KEY: "una-clave-propia-larga" };

    // Performs assertions.
    expect(() => loadEnv(production)).toThrow("S3_SECRET_KEY: En producción");
    expect(() => loadEnv({ ...production, S3_SECRET_KEY: "una-clave-propia-larga" })).toThrow(
      "En producción",
    );
    expect(loadEnv({ ...production, ...ownKeys }).S3_ACCESS_KEY).toBe("propia");
    expect(loadEnv(required).S3_ACCESS_KEY).toBe("assistant");
  });

  it("fails on a missing database url", () => {
    // Performs assertions.
    expect(() => loadEnv({ JWT_PRIVATE_KEY_FILE: "secrets/jwt-private.pem" })).toThrow(
      "DATABASE_URL",
    );
  });
});

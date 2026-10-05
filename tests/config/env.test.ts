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

  it("asks for the sender address and the password file a mail server needs", () => {
    // Performs the test.
    const smtp = {
      ...required,
      SMTP_HOST: "smtp.example.com",
      PUBLIC_BASE_URL: "https://asistente.example.com",
    };

    // Performs assertions.
    expect(() => loadEnv(smtp)).toThrow("SMTP_FROM");
    expect(() => loadEnv({ ...smtp, SMTP_FROM: "a@example.com", SMTP_USER: "a" })).toThrow(
      "SMTP_PASSWORD_FILE",
    );
    expect(loadEnv({ ...smtp, SMTP_FROM: "a@example.com" }).SMTP_PORT).toBe(587);
  });

  it("keeps production mail encrypted and its reset links on https", () => {
    // Performs the test.
    const production = {
      ...required,
      NODE_ENV: "production",
      S3_ACCESS_KEY: "propia",
      S3_SECRET_KEY: "una-clave-propia-larga",
      SMTP_HOST: "smtp.example.com",
      SMTP_FROM: "avisos@example.com",
    };

    // Performs assertions.
    expect(() => loadEnv({ ...required, SMTP_HOST: "x", SMTP_FROM: "sin-arroba" })).toThrow(
      "SMTP_FROM",
    );
    // Whatever NODE_ENV says, a mailed link needs an address that is not this machine over http
    const development = { ...required, SMTP_HOST: "x", SMTP_FROM: "a@example.com" };
    expect(() => loadEnv(development)).toThrow("PUBLIC_BASE_URL");
    expect(() =>
      loadEnv({ ...development, PUBLIC_BASE_URL: "http://asistente.example.com" }),
    ).toThrow("PUBLIC_BASE_URL");
    expect(loadEnv({ ...development, PUBLIC_BASE_URL: "http://localhost:3000" }).SMTP_HOST).toBe(
      "x",
    );
    expect(() => loadEnv(production)).toThrow("PUBLIC_BASE_URL");
    expect(() =>
      loadEnv({ ...production, PUBLIC_BASE_URL: "http://asistente.example.com" }),
    ).toThrow("PUBLIC_BASE_URL");
    const https = { ...production, PUBLIC_BASE_URL: "https://asistente.example.com" };
    expect(() => loadEnv({ ...https, SMTP_INSECURE: "true" })).toThrow("SMTP_INSECURE");
    expect(loadEnv(https).SMTP_INSECURE).toBe(false);
    expect(loadEnv({ ...required, SMTP_INSECURE: "true" }).SMTP_INSECURE).toBe(true);
  });
});

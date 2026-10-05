import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { Database } from "../src/db/client.js";
import { testSigner } from "./support/keys.js";

describe("app", async () => {
  // The health check never touches the database
  const app = await buildApp({ db: {} as Database, signer: testSigner(), systems: new Map() });

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

  it("publishes the signing key as a JWKS", async () => {
    // Performs the test.
    const response = await app.inject({ method: "GET", url: "/.well-known/jwks.json" });
    const [key] = response.json().keys;

    // Performs assertions.
    expect(response.statusCode).toBe(200);
    expect(key.kty).toBe("RSA");
    expect(key.alg).toBe("RS256");
    expect(key.use).toBe("sig");
    expect(key.d).toBeUndefined();
  });

  it("rejects a protected route without a token", async () => {
    // Performs the test.
    const response = await app.inject({ method: "GET", url: "/auth/me" });

    // Performs assertions.
    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ ok: false, error: "missing_token" });
  });
});

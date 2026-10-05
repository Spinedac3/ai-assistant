import { createSecretKey } from "node:crypto";
import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  type ExternalSystem,
  SystemTokenError,
  verifySystemToken,
} from "../../src/auth/externalSystems.js";
import { rsaKeys } from "../support/keys.js";

const hmacKey = createSecretKey("a-shared-secret-of-enough-length-for-hs256", "utf8");
const rsa = rsaKeys();

const systems = new Map<string, ExternalSystem>([
  ["erp", { code: "erp", algorithm: "HS256", key: hmacKey, autoProvisionRole: null }],
  ["portal", { code: "portal", algorithm: "RS256", key: rsa.publicKey, autoProvisionRole: "user" }],
]);

/**
 * Signs a system login token with the given lifetime
 *
 * @param   iss         System code
 * @param   alg         Signing algorithm
 * @param   key         Signing key
 * @param   lifetime    Seconds between iat and exp
 * @param   issuedAgo   Seconds since iat
 *
 * @return  The token
 */
function systemToken(
  iss: string,
  alg: "HS256" | "RS256",
  key: Parameters<SignJWT["sign"]>[0],
  lifetime = 60,
  issuedAgo = 0,
): Promise<string> {
  const iat = Math.floor(Date.now() / 1000) - issuedAgo;

  return new SignJWT({ email: "ana@example.com", name: "Ana López" })
    .setProtectedHeader({ alg })
    .setIssuer(iss)
    .setSubject("E-104")
    .setIssuedAt(iat)
    .setExpirationTime(iat + lifetime)
    .sign(key);
}

/**
 * Captures the code of the rejection a token gets
 *
 * @param   token  Token to verify
 *
 * @return  The SystemTokenError code
 */
async function rejection(token: string): Promise<string> {
  try {
    await verifySystemToken(token, systems);
  } catch (error) {
    if (error instanceof SystemTokenError) {
      return error.code;
    }
  }

  return "accepted";
}

describe("externalSystems", () => {
  it("accepts an HS256 token from its system", async () => {
    // Performs the test.
    const identity = await verifySystemToken(await systemToken("erp", "HS256", hmacKey), systems);

    // Performs assertions.
    expect(identity).toEqual({
      systemCode: "erp",
      externalId: "E-104",
      email: "ana@example.com",
      name: "Ana López",
    });
  });

  it("accepts an RS256 token from its system", async () => {
    // Performs the test.
    const identity = await verifySystemToken(
      await systemToken("portal", "RS256", rsa.privateKey),
      systems,
    );

    // Performs assertions.
    expect(identity.systemCode).toBe("portal");
  });

  it("rejects a system that is not registered", async () => {
    // Performs assertions.
    expect(await rejection(await systemToken("payroll", "HS256", hmacKey))).toBe("unknown_system");
  });

  it("rejects an algorithm the system does not use", async () => {
    // Performs assertions.
    expect(await rejection(await systemToken("portal", "HS256", hmacKey))).toBe("invalid_token");
  });

  it("rejects a token signed with another secret", async () => {
    // Performs the test.
    const other = createSecretKey("another-shared-secret-of-enough-length-here", "utf8");

    // Performs assertions.
    expect(await rejection(await systemToken("erp", "HS256", other))).toBe("invalid_token");
  });

  it("rejects an expired token", async () => {
    // Performs assertions.
    expect(await rejection(await systemToken("erp", "HS256", hmacKey, 60, 120))).toBe(
      "token_expired",
    );
  });

  it("rejects a lifetime longer than ten minutes", async () => {
    // Performs assertions.
    expect(await rejection(await systemToken("erp", "HS256", hmacKey, 601))).toBe("invalid_token");
  });

  it("rejects something that is not a JWT", async () => {
    // Performs assertions.
    expect(await rejection("not-a-token-at-all")).toBe("invalid_token");
  });
});

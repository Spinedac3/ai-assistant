import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { createTokenSigner } from "../../src/auth/tokens.js";
import { rsaKeys, testSigner } from "../support/keys.js";

const claims = { sub: 7, role: "user", scopes: ["chat.use"], email: "ana@example.com" };

describe("tokens", () => {
  it("verifies the claims it signed", async () => {
    // Performs the test.
    const signer = testSigner();
    const verified = await signer.verify(await signer.sign(claims));

    // Performs assertions.
    expect(verified.sub).toBe(7);
    expect(verified.role).toBe("user");
    expect(verified.scopes).toEqual(["chat.use"]);
    expect(verified.email).toBe("ana@example.com");
    expect(verified.exp - verified.iat).toBe(900);
  });

  it("rejects a token signed by another key", async () => {
    // Performs the test.
    const other = testSigner();
    const token = await other.sign(claims);

    // Performs assertions.
    await expect(testSigner().verify(token)).rejects.toThrow();
  });

  it("rejects a token from another issuer with the same key", async () => {
    // Performs the test.
    const { privateKey } = rsaKeys();
    const token = await createTokenSigner(privateKey, "someone-else", 900).sign(claims);

    // Performs assertions.
    await expect(
      createTokenSigner(privateKey, "ai-assistant-test", 900).verify(token),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    // Performs the test.
    const { privateKey } = rsaKeys();
    const expired = await new SignJWT({ scopes: [] })
      .setProtectedHeader({ alg: "RS256" })
      .setSubject("7")
      .setIssuer("ai-assistant-test")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(privateKey);

    // Performs assertions.
    await expect(
      createTokenSigner(privateKey, "ai-assistant-test", 900).verify(expired),
    ).rejects.toThrow();
  });

  it("publishes the key id the tokens carry", async () => {
    // Performs the test.
    const signer = testSigner();
    const token = await signer.sign(claims);
    const header = JSON.parse(Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"));
    const { keys } = await signer.jwks();

    // Performs assertions.
    expect(keys).toHaveLength(1);
    expect(keys[0]?.kid).toBe(header.kid);
  });
});

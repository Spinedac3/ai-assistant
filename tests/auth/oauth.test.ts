import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consentPage } from "../../src/auth/consentPage.js";
import { consumeCode, createCode, verifyPkce } from "../../src/auth/oauthCodes.js";
import { allowedRedirect } from "../../src/routes/oauth.js";

const VERIFIER = "a-verifier-of-enough-length-for-pkce-0123456789abcdef";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

const request = {
  clientId: "mcp_1",
  clientName: "Cliente",
  redirectUri: "https://client.example.com/callback",
  codeChallenge: CHALLENGE,
};

/**
 * Creates a code for a fixed client
 *
 * @return  The code
 */
function newCode(): string {
  return createCode({ ...request, userId: 7 });
}

describe("oauth", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("redeems a code only once", () => {
    // Performs the test.
    const code = newCode();
    const first = consumeCode(code);
    const second = consumeCode(code);

    // Performs assertions.
    expect(first?.userId).toBe(7);
    expect(second).toBeNull();
  });

  it("refuses a code after two minutes", () => {
    // Performs the test.
    vi.useFakeTimers();
    const code = newCode();
    vi.advanceTimersByTime(2 * 60_000);

    // Performs assertions.
    expect(consumeCode(code)).toBeNull();
  });

  it("matches only the verifier behind the challenge", () => {
    // Performs assertions.
    expect(verifyPkce(VERIFIER, CHALLENGE)).toBe(true);
    expect(verifyPkce(`${VERIFIER}x`, CHALLENGE)).toBe(false);
    expect(verifyPkce("", CHALLENGE)).toBe(false);
  });

  it("allows https redirects and plain http only to this machine", () => {
    // Performs assertions.
    expect(allowedRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(allowedRedirect("http://localhost:3118/callback")).toBe(true);
    expect(allowedRedirect("http://127.0.0.1/callback")).toBe(true);
    expect(allowedRedirect("http://[::1]:9000/callback")).toBe(true);
    expect(allowedRedirect("http://client.example.com/callback")).toBe(false);
    expect(allowedRedirect("http://localhost.evil.com/callback")).toBe(false);
    expect(allowedRedirect("javascript:alert(1)")).toBe(false);
    expect(allowedRedirect("not a url")).toBe(false);
  });

  it("escapes every value the client controls on the consent page", () => {
    // Performs the test.
    const page = consentPage("Lumen", {
      ...request,
      clientName: '<script>alert("x")</script>',
      state: '"><img src=x onerror=alert(1)>',
    });

    // Performs assertions.
    expect(page).not.toContain("<script>");
    expect(page).not.toContain("<img");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain('value="&quot;&gt;&lt;img src=x onerror=alert(1)&gt;"');
  });
});

import { createHash, timingSafeEqual } from "node:crypto";
import { generateToken } from "./opaqueTokens.js";

// Only covers the browser redirect back to the client
const CODE_TTL_MS = 2 * 60_000;

export interface PendingCode {
  clientId: string;
  userId: number;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

// In memory: codes live two minutes, and a restart in the middle only means logging in again.
// More than one server instance would need them in the database
const pending = new Map<string, PendingCode>();

/**
 * Creates a single-use authorization code
 *
 * @param   data  What the code stands for
 *
 * @return  The code in clear, sent in the redirect
 */
export function createCode(data: Omit<PendingCode, "expiresAt">): string {
  const now = Date.now();

  for (const [code, entry] of pending) {
    if (entry.expiresAt <= now) {
      pending.delete(code);
    }
  }

  const code = generateToken("asc");
  pending.set(code, { ...data, expiresAt: now + CODE_TTL_MS });

  return code;
}

/**
 * Takes a code out of the store, so it can never be redeemed twice
 *
 * @param   code  Code in clear
 *
 * @return  Its data, or null when unknown or expired
 */
export function consumeCode(code: string): PendingCode | null {
  const entry = pending.get(code);
  pending.delete(code);

  return entry && entry.expiresAt > Date.now() ? entry : null;
}

/**
 * Checks a PKCE S256 verifier against the challenge sent at authorization
 *
 * @param   verifier   Verifier sent with the code
 * @param   challenge  Challenge stored with the code
 *
 * @return  Whether they match
 */
export function verifyPkce(verifier: string, challenge: string): boolean {
  const computed = Buffer.from(createHash("sha256").update(verifier).digest("base64url"));
  const expected = Buffer.from(challenge);

  return computed.length === expected.length && timingSafeEqual(computed, expected);
}

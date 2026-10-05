import { createHash, randomBytes } from "node:crypto";

/**
 * Generates an unguessable token with a prefix that secret scanners and logs can recognize
 *
 * @param   prefix  Kind of token
 *
 * @return  The token in clear, shown once and stored only hashed
 */
export function generateToken(prefix: "ast" | "asr" | "asc"): string {
  return `${prefix}_${randomBytes(32).toString("base64url")}`;
}

/**
 * Hashes a token the way it is stored
 *
 * @param   value  Token in clear
 *
 * @return  The sha256 hex digest
 */
export function hashToken(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

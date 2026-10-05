import { generateKeyPairSync, type KeyObject } from "node:crypto";
import { createTokenSigner, type TokenSigner } from "../../src/auth/tokens.js";

/**
 * Generates a throwaway RSA key pair for a test
 *
 * @return  The private and public keys
 */
export function rsaKeys(): { privateKey: KeyObject; publicKey: KeyObject } {
  return generateKeyPairSync("rsa", { modulusLength: 2048 });
}

/**
 * Builds a token signer over a throwaway key
 *
 * @param   ttlSeconds  Lifetime of each token
 *
 * @return  The signer
 */
export function testSigner(ttlSeconds = 900): TokenSigner {
  return createTokenSigner(rsaKeys().privateKey, "ai-assistant-test", ttlSeconds);
}

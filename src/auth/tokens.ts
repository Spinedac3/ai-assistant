import { createHash, createPrivateKey, createPublicKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { exportJWK, type JWK, jwtVerify, SignJWT } from "jose";

export interface AccessClaims {
  sub: number;
  role: string | null;
  scopes: string[];
  email: string;
  systemCode?: string;
}

export interface VerifiedAccess extends AccessClaims {
  iat: number;
  exp: number;
}

export interface TokenSigner {
  sign: (claims: AccessClaims) => Promise<string>;
  verify: (token: string) => Promise<VerifiedAccess>;
  jwks: () => Promise<{ keys: JWK[] }>;
  ttlSeconds: number;
}

/**
 * Reads the RS256 private key from its own file, never from the environment
 *
 * @param   path  PEM file with the private key
 *
 * @return  The private key
 */
export function readPrivateKey(path: string): KeyObject {
  return createPrivateKey(readFileSync(path, "utf8"));
}

/**
 * Builds the signer of the assistant's own access tokens
 *
 * @param   privateKey  RS256 private key
 * @param   issuer      Value of the iss claim
 * @param   ttlSeconds  Lifetime of each token
 *
 * @return  Sign, verify and JWKS functions over one key pair
 */
export function createTokenSigner(
  privateKey: KeyObject,
  issuer: string,
  ttlSeconds: number,
): TokenSigner {
  const publicKey = createPublicKey(privateKey);
  const kid = createHash("sha256")
    .update(publicKey.export({ type: "spki", format: "der" }))
    .digest("base64url")
    .slice(0, 16);

  return {
    ttlSeconds,

    sign: (claims) =>
      new SignJWT({
        role: claims.role,
        scopes: claims.scopes,
        email: claims.email,
        sys: claims.systemCode,
      })
        .setProtectedHeader({ alg: "RS256", kid })
        .setSubject(String(claims.sub))
        .setIssuer(issuer)
        .setIssuedAt()
        .setExpirationTime(`${ttlSeconds}s`)
        .sign(privateKey),

    verify: async (token) => {
      const { payload } = await jwtVerify(token, publicKey, { issuer, algorithms: ["RS256"] });

      return {
        sub: Number(payload.sub),
        role: (payload.role as string | null | undefined) ?? null,
        scopes: Array.isArray(payload.scopes) ? (payload.scopes as string[]) : [],
        email: String(payload.email ?? ""),
        systemCode: payload.sys as string | undefined,
        iat: payload.iat ?? 0,
        exp: payload.exp ?? 0,
      };
    },

    jwks: async () => {
      const jwk = await exportJWK(publicKey);

      return { keys: [{ ...jwk, kid, alg: "RS256", use: "sig" }] };
    },
  };
}

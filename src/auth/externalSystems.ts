import { createPublicKey, createSecretKey, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { decodeJwt, decodeProtectedHeader, jwtVerify } from "jose";
import { z } from "zod";

export interface ExternalSystem {
  code: string;
  algorithm: "HS256" | "RS256";
  key: KeyObject;
  autoProvisionRole: string | null;
}

export interface SystemIdentity {
  systemCode: string;
  externalId: string;
  email: string;
  name: string;
}

export class SystemTokenError extends Error {
  /**
   * Builds a rejection of an external system token
   *
   * @param   code     Machine-readable reason
   * @param   message  Reason in Spanish
   */
  constructor(
    public readonly code: "invalid_token" | "token_expired" | "unknown_system",
    message: string,
  ) {
    super(message);
    this.name = "SystemTokenError";
  }
}

// A system token only bridges one login, so a long lifetime only widens replay
const MAX_LIFETIME_SECONDS = 600;

const fileSchema = z.array(
  z.object({
    code: z.string().regex(/^[a-z0-9_-]{2,30}$/),
    algorithm: z.enum(["HS256", "RS256"]),
    keyFile: z.string().min(1),
    autoProvisionRole: z.string().min(1).nullable().default(null),
  }),
);

const payloadSchema = z.object({
  iss: z.string().min(1),
  sub: z.string().min(1),
  email: z.string().email(),
  name: z.string().min(1),
  iat: z.number(),
  exp: z.number(),
});

/**
 * Loads the external systems allowed to sign logins, with their keys read from files
 *
 * @param   path  JSON file listing the systems
 *
 * @return  The systems by code
 */
export function loadExternalSystems(path: string | undefined): Map<string, ExternalSystem> {
  const systems = new Map<string, ExternalSystem>();

  if (!path) {
    return systems;
  }

  for (const entry of fileSchema.parse(JSON.parse(readFileSync(path, "utf8")))) {
    const material = readFileSync(entry.keyFile);
    const key =
      entry.algorithm === "HS256"
        ? createSecretKey(material.toString("utf8").trim(), "utf8")
        : createPublicKey(material);

    systems.set(entry.code, {
      code: entry.code,
      algorithm: entry.algorithm,
      key,
      autoProvisionRole: entry.autoProvisionRole,
    });
  }

  return systems;
}

/**
 * Verifies a login token signed by an external system
 *
 * @param   token    JWT whose iss names the system
 * @param   systems  Systems allowed to sign
 *
 * @return  The identity the system vouches for
 *
 * @throws  SystemTokenError
 */
export async function verifySystemToken(
  token: string,
  systems: Map<string, ExternalSystem>,
): Promise<SystemIdentity> {
  let issuer: string | undefined;
  let algorithm: string | undefined;

  try {
    issuer = decodeJwt(token).iss;
    algorithm = decodeProtectedHeader(token).alg;
  } catch {
    throw new SystemTokenError("invalid_token", "El token no tiene formato JWT");
  }

  const system = issuer ? systems.get(issuer) : undefined;
  if (!system) {
    throw new SystemTokenError("unknown_system", `Sistema no registrado: ${issuer ?? "(sin iss)"}`);
  }

  // The algorithm is pinned per system so a public key can never be used as an HMAC secret
  if (algorithm !== system.algorithm) {
    throw new SystemTokenError("invalid_token", `Algoritmo no permitido para ${system.code}`);
  }

  let claims: unknown;
  try {
    ({ payload: claims } = await jwtVerify(token, system.key, { algorithms: [system.algorithm] }));
  } catch (error) {
    const expired = (error as { code?: string }).code === "ERR_JWT_EXPIRED";
    throw new SystemTokenError(
      expired ? "token_expired" : "invalid_token",
      expired ? "El token del sistema expiró" : "Firma inválida",
    );
  }

  const payload = payloadSchema.safeParse(claims);
  if (!payload.success) {
    throw new SystemTokenError("invalid_token", "Faltan datos en el token del sistema");
  }

  if (payload.data.exp - payload.data.iat > MAX_LIFETIME_SECONDS) {
    throw new SystemTokenError("invalid_token", "La vida del token del sistema es demasiado larga");
  }

  return {
    systemCode: system.code,
    externalId: payload.data.sub,
    email: payload.data.email,
    name: payload.data.name,
  };
}

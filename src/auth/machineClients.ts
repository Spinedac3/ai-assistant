import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { RUN_CLIENT_ID } from "../mcp/runTokens.js";

export interface MachineClient {
  clientId: string;
  // Hash of the secret; the secret itself lives only in the client's own file
  secretHash: Buffer;
}

export const MACHINE_CLIENT_ID = /^[a-z0-9_-]{2,40}$/;

const fileSchema = z.array(
  z.object({
    // The chat's own run tokens carry this name; a client called the same could end them
    client_id: z
      .string()
      .regex(MACHINE_CLIENT_ID)
      .refine((id) => id !== RUN_CLIENT_ID, "Ese nombre lo usa el propio asistente"),
    secret_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
);

/**
 * Hashes a machine client's secret as the file keeps it
 *
 * @param   secret  The secret in clear
 *
 * @return  Its SHA-256, in hex
 */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/**
 * Loads the systems allowed to ask for run tokens, declared in a file and never in the database
 *
 * @param   path  JSON file listing them
 *
 * @return  The clients by id; none when there is no file
 */
export function loadMachineClients(path: string | undefined): Map<string, MachineClient> {
  const clients = new Map<string, MachineClient>();
  if (!path) {
    return clients;
  }
  for (const entry of fileSchema.parse(JSON.parse(readFileSync(path, "utf8")))) {
    clients.set(entry.client_id, {
      clientId: entry.client_id,
      secretHash: Buffer.from(entry.secret_sha256, "hex"),
    });
  }

  return clients;
}

/**
 * Tells which machine client sent a request, from its HTTP Basic credentials
 *
 * @param   header   The Authorization header
 * @param   clients  Declared clients
 *
 * @return  The client, or null when the credentials are missing or wrong
 */
export function machineClientOf(
  header: string | undefined,
  clients: Map<string, MachineClient>,
): MachineClient | null {
  if (!header?.startsWith("Basic ")) {
    return null;
  }
  const decoded = Buffer.from(header.slice("Basic ".length).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 1) {
    return null;
  }
  const client = clients.get(decoded.slice(0, colon));
  // Compared in constant time, and hashed first so both sides always have the same length
  const offered = Buffer.from(hashSecret(decoded.slice(colon + 1)), "hex");

  return client && timingSafeEqual(offered, client.secretHash) ? client : null;
}

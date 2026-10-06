import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { hashSecret, MACHINE_CLIENT_ID } from "../auth/machineClients.js";

const clientId = process.argv[2] ?? "";
const listPath = process.env.MACHINE_CLIENTS_FILE ?? "secrets/machine-clients.json";

if (!MACHINE_CLIENT_ID.test(clientId)) {
  throw new Error("Uso: pnpm machine:create <cliente>, con minúsculas, números, - o _");
}

// The secret goes to a file for the other system to read; this server keeps only its hash
const secret = randomBytes(32).toString("base64url");
const secretPath = join(dirname(listPath), `${clientId}.secret`);
const list: Array<{ client_id: string; secret_sha256: string }> = existsSync(listPath)
  ? JSON.parse(readFileSync(listPath, "utf8"))
  : [];
const entry = { client_id: clientId, secret_sha256: hashSecret(secret) };

mkdirSync(dirname(listPath), { recursive: true });
writeFileSync(secretPath, secret, { mode: 0o600 });
writeFileSync(
  listPath,
  `${JSON.stringify([...list.filter((item) => item.client_id !== clientId), entry], null, 2)}\n`,
);
console.info(
  `Cliente ${clientId} declarado en ${listPath}; su secreto quedó en ${secretPath}. ` +
    "Cópialo a la máquina del otro sistema y bórralo de aquí. Pon MACHINE_CLIENTS_FILE y reinicia.",
);

import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const path = process.argv[2] ?? "secrets/jwt-private.pem";

// Overwriting would silently log every user out and break the tokens others verify
if (existsSync(path)) {
  throw new Error(`Ya existe ${path}; bórrala a mano si de verdad quieres rotar la llave`);
}

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });

mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
console.info(`Llave privada RS256 creada en ${path}`);

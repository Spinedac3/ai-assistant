import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const path = process.argv[2] ?? "secrets/kek.key";

// Overwriting would leave every stored source password unreadable
if (existsSync(path)) {
  throw new Error(`Ya existe ${path}; sin ella no se pueden leer las contraseñas guardadas`);
}

mkdirSync(dirname(path), { recursive: true });
writeFileSync(path, randomBytes(32).toString("base64"), { mode: 0o600 });
console.info(`Llave maestra creada en ${path}; respáldala aparte de la base`);

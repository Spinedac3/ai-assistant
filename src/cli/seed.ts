import { connectDatabase } from "../db/client.js";
import { seedBase } from "../db/seed.js";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("Falta DATABASE_URL");
}

const database = connectDatabase(url);
await seedBase(database.db);
await database.close();
console.info("Roles y permisos base listos");

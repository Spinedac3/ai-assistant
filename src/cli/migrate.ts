import { migrate } from "drizzle-orm/node-postgres/migrator";
import { connectDatabase } from "../db/client.js";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("Falta DATABASE_URL");
}

const database = connectDatabase(url);
await migrate(database.db, { migrationsFolder: "./src/db/migrations" });
await database.close();
console.info("Migraciones aplicadas");

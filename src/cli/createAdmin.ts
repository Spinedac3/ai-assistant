import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { eq } from "drizzle-orm";
import { hashPassword, passwordProblem } from "../auth/password.js";
import { connectDatabase } from "../db/client.js";
import { roles, users } from "../db/schema.js";
import { seedBase } from "../db/seed.js";

/**
 * Asks for a value without echoing what is typed
 *
 * @param   question  Prompt shown to the operator
 *
 * @return  The typed value
 */
function askHidden(question: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, _encoding, done) {
      if (!muted) {
        process.stdout.write(chunk);
      }
      done();
    },
  });
  const prompt = createInterface({ input: process.stdin, output, terminal: true });

  return new Promise((resolve) => {
    prompt.question(question, (answer) => {
      prompt.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

const { values } = parseArgs({
  options: { email: { type: "string" }, name: { type: "string" } },
});

if (!values.email || !values.name) {
  throw new Error('Uso: pnpm admin:create --email tu@empresa.com --name "Tu Nombre"');
}

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("Falta DATABASE_URL");
}

const password = await askHidden("Contraseña: ");
const problem = passwordProblem(password, [values.email, values.name]);
if (problem) {
  throw new Error(problem);
}

if ((await askHidden("Repite la contraseña: ")) !== password) {
  throw new Error("Las contraseñas no coinciden");
}

const database = connectDatabase(url);
await seedBase(database.db);

const [adminRole] = await database.db
  .select({ id: roles.id })
  .from(roles)
  .where(eq(roles.code, "admin"))
  .limit(1);

await database.db.insert(users).values({
  email: values.email,
  displayName: values.name,
  passwordHash: await hashPassword(password),
  primaryRoleId: adminRole?.id ?? null,
});

await database.close();
console.info(`Administrador ${values.email} creado`);

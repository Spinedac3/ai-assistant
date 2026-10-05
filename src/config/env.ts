import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().url(),
  ASSISTANT_NAME: z.string().min(1).default("Asistente"),
  // Not TZ: that one would shift every Date in the process; storage stays in UTC
  APP_TIMEZONE: z
    .string()
    .refine((zone) => Intl.supportedValuesOf("timeZone").includes(zone) || zone === "UTC", {
      message: "Zona horaria IANA desconocida",
    })
    .default("UTC"),
  JWT_PRIVATE_KEY_FILE: z.string().min(1),
  JWT_ISSUER: z.string().min(1).default("ai-assistant"),
  JWT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  EXTERNAL_SYSTEMS_FILE: z.string().min(1).optional(),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Validates the process environment and fails loudly on the first bad value
 *
 * @param   source  Variables to validate
 *
 * @return  The typed configuration
 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const problems = parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Configuración inválida:\n  ${problems.join("\n  ")}`);
  }

  return parsed.data;
}

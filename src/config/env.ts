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
  // Markdown with what the organization is, its vocabulary and what the assistant covers
  ASSISTANT_CONTEXT_FILE: z.string().min(1).optional(),
  // Public address of this server, used in OAuth metadata and the MCP 401 challenge
  PUBLIC_BASE_URL: z.string().url().optional(),
  MCP_INTENT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  CLAUDE_BIN: z.string().min(1).default("claude"),
  CHAT_MODEL: z.string().min(1).default("claude-opus-5-5"),
  CHAT_WORKSPACES_DIR: z.string().min(1).optional(),
  RATE_LIMIT_MSGS_PER_HOUR: z.coerce.number().int().positive().default(60),
  RATE_LIMIT_MSGS_PER_DAY: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_TOKENS_PER_DAY: z.coerce.number().int().positive().default(2_000_000),
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

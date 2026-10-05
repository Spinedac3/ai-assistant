import { z } from "zod";

const DEFAULT_S3_ACCESS_KEY = "assistant";
const DEFAULT_S3_SECRET_KEY = "assistant-secret";

// Document search: Solr holds the index, the embed service the vectors, S3 storage the originals
const ragSchema = z.object({
  SOLR_URL: z.string().url().default("http://localhost:8983"),
  EMBED_URL: z.string().url().default("http://localhost:5000"),
  S3_ENDPOINT: z.string().url().default("http://localhost:9000"),
  S3_ACCESS_KEY: z.string().min(1).default(DEFAULT_S3_ACCESS_KEY),
  S3_SECRET_KEY: z.string().min(1).default(DEFAULT_S3_SECRET_KEY),
  S3_BUCKET: z.string().min(3).default("documents"),
  // The worker that indexes uploaded documents; off when another process does it
  DOCS_WORKER_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  DOCS_WORKER_POLL_MS: z.coerce.number().int().positive().default(5_000),
});

/**
 * Tells whether an address can go in a mail: https, or http only to this machine
 *
 * @param   url  Public address of the server
 *
 * @return  Whether links to it may be mailed
 */
function mailableBase(url: string | undefined): boolean {
  if (!url) {
    return false;
  }
  const { protocol, hostname } = new URL(url);

  return protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

const envSchema = z
  .object({
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
    // Master key that seals the passwords of the sources; a file, never a variable
    SECRETS_KEK_FILE: z.string().min(1).default("secrets/kek.key"),
    JWT_ISSUER: z.string().min(1).default("ai-assistant"),
    JWT_TTL_SECONDS: z.coerce.number().int().positive().default(900),
    EXTERNAL_SYSTEMS_FILE: z.string().min(1).optional(),
    // Markdown with what the organization is, its vocabulary and what the assistant covers
    ASSISTANT_CONTEXT_FILE: z.string().min(1).optional(),
    // Public address of this server, used in OAuth metadata and the MCP 401 challenge
    PUBLIC_BASE_URL: z.string().url().optional(),
    // Addresses or CIDRs of the reverse proxies in front of this server, comma separated. Without it
    // X-Forwarded-For is ignored, since anyone can write it and it would pick the IP that rate limits
    // and audits see
    TRUST_PROXY: z.string().min(1).optional(),
    MCP_INTENT_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
    CLAUDE_BIN: z.string().min(1).default("claude"),
    CHAT_MODEL: z.string().min(1).default("claude-opus-5-5"),
    CHAT_WORKSPACES_DIR: z.string().min(1).optional(),
    RATE_LIMIT_MSGS_PER_HOUR: z.coerce.number().int().positive().default(60),
    RATE_LIMIT_MSGS_PER_DAY: z.coerce.number().int().positive().default(300),
    RATE_LIMIT_TOKENS_PER_DAY: z.coerce.number().int().positive().default(2_000_000),
    // Mail for notices and password resets; without a host there are none
    SMTP_HOST: z.string().min(1).optional(),
    SMTP_PORT: z.coerce.number().int().positive().default(587),
    SMTP_USER: z.string().min(1).optional(),
    SMTP_PASSWORD_FILE: z.string().min(1).optional(),
    SMTP_FROM: z.string().includes("@").optional(),
    // Only for a local mail catcher; refused in production
    SMTP_INSECURE: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
    // The built web panel, served under /panel
    PANEL_DIR: z.string().min(1).default("web/dist"),
    NOTICES_WORKER_POLL_MS: z.coerce.number().int().positive().default(10_000),
    ...ragSchema.shape,
  })
  // The storage defaults match docker-compose and are public; in production they would open every
  // original of every area to whoever reaches the storage
  .superRefine((env, context) => {
    if (
      env.NODE_ENV === "production" &&
      (env.S3_ACCESS_KEY === DEFAULT_S3_ACCESS_KEY || env.S3_SECRET_KEY === DEFAULT_S3_SECRET_KEY)
    ) {
      context.addIssue({
        code: "custom",
        path: ["S3_SECRET_KEY"],
        message: "En producción las credenciales de S3 no pueden ser las de ejemplo",
      });
    }
    if (env.SMTP_HOST && !env.SMTP_FROM) {
      context.addIssue({
        code: "custom",
        path: ["SMTP_FROM"],
        message: "Con SMTP_HOST hace falta la dirección que envía (SMTP_FROM)",
      });
    }
    if (env.NODE_ENV === "production" && env.SMTP_INSECURE) {
      context.addIssue({
        code: "custom",
        path: ["SMTP_INSECURE"],
        message: "En producción el correo siempre va cifrado",
      });
    }
    // Mailed reset links point here, whatever NODE_ENV says: without it they would lead to
    // localhost, and over http the token would travel in clear text
    if (env.SMTP_HOST && !mailableBase(env.PUBLIC_BASE_URL)) {
      context.addIssue({
        code: "custom",
        path: ["PUBLIC_BASE_URL"],
        message: "Con correo hace falta PUBLIC_BASE_URL con https (http solo en esta máquina)",
      });
    }
    if (env.SMTP_USER && !env.SMTP_PASSWORD_FILE) {
      context.addIssue({
        code: "custom",
        path: ["SMTP_PASSWORD_FILE"],
        message: "Con SMTP_USER hace falta el archivo de su contraseña (SMTP_PASSWORD_FILE)",
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export type RagEnv = z.infer<typeof ragSchema>;

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

/**
 * Validates only the document search settings, for tools that run without the server
 *
 * @param   source  Variables to validate
 *
 * @return  The typed settings
 */
export function loadRagEnv(source: NodeJS.ProcessEnv = process.env): RagEnv {
  return ragSchema.parse(source);
}

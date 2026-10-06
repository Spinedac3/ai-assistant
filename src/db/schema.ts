import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";
import type { TraceEntry } from "../chat/trace.js";
import type { BaseColumn } from "../creator/columns.js";
import type { ToolDefinitionSpec } from "../creator/definition.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, precision: 3 });

const idPk = () => integer("id").primaryKey().generatedAlwaysAsIdentity();

const auditFields = () => ({
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  createdBy: integer("created_by"),
  updatedAt: timestamptz("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
  updatedBy: integer("updated_by"),
  deletedAt: timestamptz("deleted_at"),
  deletedBy: integer("deleted_by"),
});

export const users = pgTable(
  "users",
  {
    id: idPk(),
    email: varchar("email", { length: 255 }).notNull(),
    displayName: varchar("display_name", { length: 255 }).notNull(),
    // Null for accounts that only enter through an external system
    passwordHash: text("password_hash"),
    primaryRoleId: integer("primary_role_id"),
    active: boolean("active").notNull().default(true),
    // An account of a system, not a person: its activity is counted apart from people's
    isService: boolean("is_service").notNull().default(false),
    failedLogins: integer("failed_logins").notNull().default(0),
    lockedUntil: timestamptz("locked_until"),
    // Tokens issued before this instant are rejected even if they have not expired
    tokensRevokedAt: timestamptz("tokens_revoked_at"),
    ...auditFields(),
  },
  (t) => [uniqueIndex("users_email_unique").on(sql`lower(${t.email})`)],
);

export const userIdentities = pgTable(
  "user_identities",
  {
    id: idPk(),
    userId: integer("user_id").notNull(),
    systemCode: varchar("system_code", { length: 30 }).notNull(),
    externalId: varchar("external_id", { length: 100 }).notNull(),
    ...auditFields(),
  },
  (t) => [
    uniqueIndex("user_identities_system_external_unique").on(t.systemCode, t.externalId),
    index("user_identities_user_idx").on(t.userId),
  ],
);

export const roles = pgTable(
  "roles",
  {
    id: idPk(),
    code: varchar("code", { length: 50 }).notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    active: boolean("active").notNull().default(true),
    ...auditFields(),
  },
  (t) => [uniqueIndex("roles_code_unique").on(t.code)],
);

export const scopes = pgTable(
  "scopes",
  {
    id: idPk(),
    code: varchar("code", { length: 100 }).notNull(),
    description: varchar("description", { length: 255 }).notNull(),
    sensitive: boolean("sensitive").notNull().default(false),
    ...auditFields(),
  },
  (t) => [uniqueIndex("scopes_code_unique").on(t.code)],
);

export const roleScopes = pgTable(
  "role_scopes",
  {
    roleId: integer("role_id").notNull(),
    scopeId: integer("scope_id").notNull(),
    grantedAt: timestamptz("granted_at").notNull().defaultNow(),
    grantedBy: integer("granted_by"),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.scopeId] })],
);

export const userExtraScopes = pgTable(
  "user_extra_scopes",
  {
    userId: integer("user_id").notNull(),
    scopeId: integer("scope_id").notNull(),
    grantedAt: timestamptz("granted_at").notNull().defaultNow(),
    grantedBy: integer("granted_by"),
    expiresAt: timestamptz("expires_at"),
    reason: varchar("reason", { length: 500 }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.scopeId] })],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: integer("user_id"),
    level: varchar("level", { length: 10, enum: ["info", "warn", "error"] })
      .notNull()
      .default("info"),
    eventCode: varchar("event_code", { length: 80 }).notNull(),
    message: text("message").notNull(),
    metadata: jsonb("metadata"),
    systemCode: varchar("system_code", { length: 30 }),
    ipAddress: varchar("ip_address", { length: 45 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("audit_logs_event_idx").on(t.eventCode, t.createdAt),
    index("audit_logs_user_idx").on(t.userId, t.createdAt),
  ],
);

export const conversations = pgTable(
  "conversations",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: integer("user_id").notNull(),
    title: varchar("title", { length: 200 }),
    status: varchar("status", { length: 20, enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    msgCount: integer("msg_count").notNull().default(0),
    lastMessageAt: timestamptz("last_message_at").notNull().defaultNow(),
    // A trial of a tool being built; the chat never lists or resumes these
    toolName: varchar("tool_name", { length: 64 }),
    ...auditFields(),
  },
  (t) => [index("conversations_user_last_idx").on(t.userId, t.lastMessageAt)],
);

// Append-only: a conversation is deleted as a whole, its messages are never edited
export const messages = pgTable(
  "messages",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    conversationId: bigint("conversation_id", { mode: "number" }).notNull(),
    role: varchar("role", { length: 20, enum: ["user", "assistant"] }).notNull(),
    content: text("content").notNull(),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    // Millionths of a dollar, so cost is never a float
    costMillionths: integer("cost_usd_millionths"),
    // The model that really answered, which an alias can move without notice
    model: varchar("model", { length: 60 }),
    finishReason: varchar("finish_reason", { length: 40 }),
    // In a trial, what each tool call of the answer received and returned
    trace: jsonb("trace").$type<TraceEntry[]>(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.id),
    // The usage report reads messages by time
    index("messages_created_idx").on(t.createdAt),
  ],
);

export const messageRatings = pgTable(
  "message_ratings",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    messageId: bigint("message_id", { mode: "number" }).notNull(),
    userId: integer("user_id").notNull(),
    stars: integer("stars").notNull(),
    comment: varchar("comment", { length: 2000 }),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at")
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    uniqueIndex("message_ratings_message_user_unique").on(t.messageId, t.userId),
    index("message_ratings_created_idx").on(t.createdAt),
  ],
);

export const rateLimits = pgTable(
  "rate_limits",
  {
    userId: integer("user_id").notNull(),
    windowType: varchar("window_type", { length: 10, enum: ["hour", "day"] }).notNull(),
    windowStart: timestamptz("window_start").notNull(),
    msgCount: integer("msg_count").notNull().default(0),
    tokensUsed: integer("tokens_used").notNull().default(0),
    costMillionths: integer("cost_millionths").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.windowType, t.windowStart] })],
);

// Settings an administrator changes at runtime, read on every use so no restart is needed
export const settings = pgTable("settings", {
  key: varchar("key", { length: 100 }).primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  updatedBy: integer("updated_by"),
});

// Metadata of every tool call; the result itself is never stored, only its hash
export const toolCalls = pgTable(
  "tool_calls",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: integer("user_id").notNull(),
    conversationId: bigint("conversation_id", { mode: "number" }),
    toolName: varchar("tool_name", { length: 100 }).notNull(),
    argsJson: jsonb("args_json").notNull(),
    success: boolean("success").notNull(),
    errorCode: varchar("error_code", { length: 60 }),
    durationMs: integer("duration_ms").notNull(),
    resultBytes: integer("result_bytes").notNull().default(0),
    resultRows: integer("result_rows"),
    truncated: boolean("truncated").notNull().default(false),
    resultHash: varchar("result_hash", { length: 64 }),
    // Which path ran it: chat, mcp, run
    origin: varchar("origin", { length: 20 }).notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("tool_calls_user_created_idx").on(t.userId, t.createdAt),
    index("tool_calls_conversation_idx").on(t.conversationId, t.id),
    index("tool_calls_created_idx").on(t.createdAt),
  ],
);

// Opaque access tokens: OAuth sessions of MCP clients and short-lived run tokens, stored hashed
export const accessTokens = pgTable(
  "access_tokens",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    userId: integer("user_id").notNull(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    accessTokenHash: varchar("access_token_hash", { length: 64 }).notNull(),
    refreshTokenHash: varchar("refresh_token_hash", { length: 64 }),
    // The refresh hash before the last rotation; presenting it again later means it was stolen
    previousRefreshHash: varchar("previous_refresh_hash", { length: 64 }),
    // When it last rotated; a client racing two refreshes is not mistaken for a thief
    rotatedAt: timestamptz("rotated_at"),
    kind: varchar("kind", { length: 20, enum: ["oauth", "run"] }).notNull(),
    // Tools of a run another system asked for, kept so the run outlives a restart of this server
    runTools: jsonb("run_tools").$type<string[]>(),
    accessExpiresAt: timestamptz("access_expires_at").notNull(),
    refreshExpiresAt: timestamptz("refresh_expires_at"),
    revokedAt: timestamptz("revoked_at"),
    lastUsedAt: timestamptz("last_used_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("access_tokens_access_hash_unique").on(t.accessTokenHash),
    uniqueIndex("access_tokens_refresh_hash_unique").on(t.refreshTokenHash),
    index("access_tokens_user_idx").on(t.userId),
    index("access_tokens_previous_refresh_idx").on(t.previousRefreshHash),
  ],
);

// What people asked through external MCP clients, kept only for a while
export const mcpIntents = pgTable(
  "mcp_intents",
  {
    id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
    userId: integer("user_id").notNull(),
    toolName: varchar("tool_name", { length: 100 }).notNull(),
    question: text("question").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("mcp_intents_created_idx").on(t.createdAt)],
);

// MCP clients registered dynamically (RFC 7591); public clients, protected by PKCE and exact redirects
export const oauthClients = pgTable(
  "oauth_clients",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    clientId: varchar("client_id", { length: 64 }).notNull(),
    clientName: varchar("client_name", { length: 200 }),
    redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("oauth_clients_client_id_unique").on(t.clientId)],
);

// Uploaded documents waiting to be indexed, and what happened to each
export const documentJobs = pgTable(
  "document_jobs",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    docCode: varchar("doc_code", { length: 100 }).notNull(),
    kind: varchar("kind", { length: 10, enum: ["upload", "reindex"] }).notNull(),
    status: varchar("status", { length: 10, enum: ["queued", "running", "done", "failed"] })
      .notNull()
      .default("queued"),
    chunks: integer("chunks"),
    error: text("error"),
    userId: integer("user_id").notNull(),
    startedAt: timestamptz("started_at"),
    finishedAt: timestamptz("finished_at"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("document_jobs_status_idx").on(t.status, t.createdAt)],
);

// External databases the tools read; the password is sealed with the master key, never stored plain
export const sources = pgTable(
  "sources",
  {
    id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
    code: varchar("code", { length: 50 }).notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    engine: varchar("engine", { length: 10, enum: ["postgres", "mysql", "mssql"] }).notNull(),
    host: varchar("host", { length: 255 }).notNull(),
    port: integer("port").notNull(),
    database: varchar("database", { length: 128 }).notNull(),
    username: varchar("username", { length: 128 }).notNull(),
    sealedPassword: text("sealed_password").notNull(),
    // Zone of the dates the source stores without one; null inherits the app's
    timeZone: varchar("time_zone", { length: 64 }),
    tls: boolean("tls").notNull().default(true),
    createdBy: integer("created_by").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sources_code_unique").on(t.code)],
);

// A PDF being turned into a document: its pages are written as Markdown in the background, and
// the person reviews the result and its suggested header before it is published
export const pdfConversions = pgTable(
  "pdf_conversions",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: integer("user_id").notNull(),
    fileName: varchar("file_name", { length: 200 }).notNull(),
    status: varchar("status", {
      length: 10,
      enum: ["queued", "running", "done", "failed", "publishing"],
    })
      .notNull()
      .default("queued"),
    // Pages written so far, and how many the file has when that can be told from it
    pagesDone: integer("pages_done").notNull().default(0),
    pagesTotal: integer("pages_total"),
    markdown: text("markdown"),
    suggested: jsonb("suggested"),
    error: text("error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    finishedAt: timestamptz("finished_at"),
  },
  (t) => [index("pdf_conversions_user_idx").on(t.userId, t.createdAt)],
);

// Excel files with the detail a tool result could not carry; deleted when they expire
export const exportFiles = pgTable(
  "export_files",
  {
    id: varchar("id", { length: 36 }).primaryKey(),
    userId: integer("user_id").notNull(),
    toolName: varchar("tool_name", { length: 100 }).notNull(),
    fileName: varchar("file_name", { length: 150 }).notNull(),
    rows: integer("rows").notNull(),
    bytes: integer("bytes").notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("export_files_expires_idx").on(t.expiresAt)],
);

// Tools made in the creator: a definition over a registered source, a draft until published
export const toolDefinitions = pgTable(
  "tool_definitions",
  {
    id: idPk(),
    name: varchar("name", { length: 64 }).notNull(),
    // A source with tools on it cannot be deleted from under them
    sourceCode: varchar("source_code", { length: 50 })
      .notNull()
      .references(() => sources.code, { onDelete: "restrict" }),
    status: varchar("status", { length: 10, enum: ["draft", "published"] })
      .notNull()
      .default("draft"),
    spec: jsonb("spec").$type<ToolDefinitionSpec>().notNull(),
    // Columns of the base as last described, so loading the tools never waits on every source
    columns: jsonb("columns").$type<BaseColumn[]>().notNull(),
    createdBy: integer("created_by").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    updatedAt: timestamptz("updated_at").notNull().defaultNow(),
    publishedAt: timestamptz("published_at"),
  },
  (t) => [uniqueIndex("tool_definitions_name_unique").on(t.name)],
);

// Notices waiting for, or done with, delivery by mail; the worker sends and retries them
export const notices = pgTable(
  "notices",
  {
    id: idPk(),
    senderUserId: integer("sender_user_id").notNull(),
    // Chosen by whoever sends; the same key from the same sender is the same notice
    key: varchar("key", { length: 100 }).notNull(),
    recipientUserId: integer("recipient_user_id").notNull(),
    recipientEmail: varchar("recipient_email", { length: 255 }).notNull(),
    subject: varchar("subject", { length: 200 }).notNull(),
    message: text("message").notNull(),
    status: varchar("status", { length: 10, enum: ["pending", "sent", "failed"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    lastError: text("last_error"),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    sentAt: timestamptz("sent_at"),
  },
  (t) => [
    uniqueIndex("notices_sender_key_unique").on(t.senderUserId, t.key),
    index("notices_due_idx").on(t.status, t.nextAttemptAt),
    index("notices_recipient_idx").on(t.recipientUserId, t.createdAt),
  ],
);

// One-time links an administrator sends so a person sets a new password; only the hash is kept
export const passwordResets = pgTable(
  "password_resets",
  {
    id: idPk(),
    userId: integer("user_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    expiresAt: timestamptz("expires_at").notNull(),
    usedAt: timestamptz("used_at"),
    createdBy: integer("created_by").notNull(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("password_resets_token_unique").on(t.tokenHash),
    index("password_resets_user_idx").on(t.userId),
  ],
);

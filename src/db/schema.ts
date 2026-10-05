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
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (t) => [index("messages_conversation_idx").on(t.conversationId, t.id)],
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
  (t) => [uniqueIndex("message_ratings_message_user_unique").on(t.messageId, t.userId)],
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

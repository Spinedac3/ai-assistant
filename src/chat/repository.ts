import { and, desc, eq, gt, ilike, isNull, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { conversations, messageRatings, messages, toolCalls } from "../db/schema.js";
import type { TraceEntry } from "./trace.js";

export interface NewMessage {
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  tokensIn?: number | null;
  tokensOut?: number | null;
  costMillionths?: number | null;
  model?: string | null;
  finishReason?: string | null;
  trace?: TraceEntry[] | null;
}

export interface StoredMessage {
  id: number;
  role: string;
  content: string;
  createdAt: Date;
}

/**
 * Starts a conversation for a user
 *
 * @param   db      Own database
 * @param   userId  Owner
 *
 * @return  The conversation id
 */
export async function createConversation(
  db: Database,
  userId: number,
  toolName: string | null = null,
): Promise<number> {
  const [row] = await db
    .insert(conversations)
    .values({ userId, toolName, createdBy: userId, updatedBy: userId })
    .returning({ id: conversations.id });

  if (!row) {
    throw new Error("No se pudo crear la conversación");
  }

  return row.id;
}

/**
 * Finds a conversation only when it belongs to the user
 *
 * @param   db              Own database
 * @param   conversationId  Conversation to look up
 * @param   userId          Expected owner
 *
 * @return  The conversation, or null
 */
export async function findConversation(
  db: Database,
  conversationId: number,
  userId: number,
  toolName: string | null = null,
) {
  const [row] = await db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
        // A trial belongs to its tool, and the chat has only its own conversations
        toolName === null ? isNull(conversations.toolName) : eq(conversations.toolName, toolName),
      ),
    )
    .limit(1);

  return row ?? null;
}

/**
 * Lists the user's conversations, most recent first
 *
 * @param   db      Own database
 * @param   userId  Owner
 * @param   search  Optional text the title must contain
 *
 * @return  The conversations
 */
export function listConversations(db: Database, userId: number, search?: string) {
  return db
    .select({
      id: conversations.id,
      title: conversations.title,
      msgCount: conversations.msgCount,
      lastMessageAt: conversations.lastMessageAt,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
        isNull(conversations.toolName),
        search ? ilike(conversations.title, `%${search}%`) : undefined,
      ),
    )
    .orderBy(desc(conversations.lastMessageAt))
    .limit(50);
}

/**
 * Reads the latest messages of a user's conversation, oldest first
 *
 * @param   db              Own database
 * @param   conversationId  Conversation to read
 * @param   userId          Expected owner
 * @param   limit           How many of the latest messages
 *
 * @return  The messages
 */
export async function latestMessages(
  db: Database,
  conversationId: number,
  userId: number,
  limit = 50,
): Promise<StoredMessage[]> {
  const newest = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.conversationId, conversationId),
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
      ),
    )
    .orderBy(desc(messages.id))
    .limit(limit);

  return newest.reverse();
}

/**
 * Appends a message and moves the conversation's counters
 *
 * @param   db       Own database
 * @param   message  Message to store
 *
 * @return  The message id
 */
export async function addMessage(db: Database, message: NewMessage): Promise<number> {
  const [row] = await db.insert(messages).values(message).returning({ id: messages.id });

  await db
    .update(conversations)
    .set({ msgCount: sql`${conversations.msgCount} + 1`, lastMessageAt: sql`now()` })
    .where(eq(conversations.id, message.conversationId));

  if (!row) {
    throw new Error("No se pudo guardar el mensaje");
  }

  return row.id;
}

/**
 * Renames a user's conversation
 *
 * @param   db              Own database
 * @param   conversationId  Conversation to rename
 * @param   userId          Expected owner
 * @param   title           New title
 *
 * @return  Whether the conversation existed for that user
 */
export async function renameConversation(
  db: Database,
  conversationId: number,
  userId: number,
  title: string,
): Promise<boolean> {
  const updated = await db
    .update(conversations)
    .set({ title, updatedBy: userId })
    .where(
      and(
        eq(conversations.id, conversationId),
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
      ),
    )
    .returning({ id: conversations.id });

  return updated.length > 0;
}

/**
 * Rates an assistant message of the user's own conversation; rating again replaces it
 *
 * @param   db         Own database
 * @param   messageId  Message to rate
 * @param   userId     Person rating
 * @param   stars      One to five
 * @param   comment    Optional comment
 *
 * @return  Whether the message is an assistant answer the user can rate
 */
export async function rateMessage(
  db: Database,
  messageId: number,
  userId: number,
  stars: number,
  comment: string | null,
): Promise<boolean> {
  const [target] = await db
    .select({ id: messages.id })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(messages.id, messageId),
        eq(messages.role, "assistant"),
        eq(conversations.userId, userId),
        isNull(conversations.deletedAt),
      ),
    )
    .limit(1);

  if (!target) {
    return false;
  }

  await db
    .insert(messageRatings)
    .values({ messageId, userId, stars, comment })
    .onConflictDoUpdate({
      target: [messageRatings.messageId, messageRatings.userId],
      set: { stars, comment, updatedAt: sql`now()` },
    });

  return true;
}

/**
 * Gives the id of the last tool call recorded in a conversation, as a marker before a turn
 *
 * @param   db              Own database
 * @param   conversationId  Conversation
 *
 * @return  The id, or zero when there is none
 */
export async function lastToolCallId(db: Database, conversationId: number): Promise<number> {
  const [row] = await db
    .select({ id: sql<number>`coalesce(max(${toolCalls.id}), 0)` })
    .from(toolCalls)
    .where(eq(toolCalls.conversationId, conversationId));

  return Number(row?.id ?? 0);
}

/**
 * Lists the tools that ran successfully in a conversation after a marker, in order
 *
 * @param   db              Own database
 * @param   conversationId  Conversation
 * @param   afterId         Marker taken before the turn
 *
 * @return  The tool names
 */
export async function toolsRunAfter(
  db: Database,
  conversationId: number,
  afterId: number,
): Promise<string[]> {
  const rows = await db
    .select({ toolName: toolCalls.toolName })
    .from(toolCalls)
    .where(
      and(
        eq(toolCalls.conversationId, conversationId),
        gt(toolCalls.id, afterId),
        eq(toolCalls.success, true),
      ),
    )
    .orderBy(toolCalls.id);

  return rows.map((row) => row.toolName);
}

import { ApiError, request } from "../api/http";
import { readEvents } from "./sse";

export interface ConversationSummary {
  id: number;
  title: string | null;
  msgCount: number;
  lastMessageAt: string;
}

export interface ChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
}

export type TurnEvent =
  | { type: "start"; conversationId: number; userMessageId: number }
  | { type: "delta"; text: string }
  | { type: "tool_call_pending"; id: string; name: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean }
  | { type: "done"; conversationId: number; assistantMessageId: number; text: string }
  | { type: "error"; error: string; message: string };

/**
 * Sends a message and yields the turn as it happens
 *
 * @param   content         What the person wrote
 * @param   conversationId  Conversation it continues, or null for a new one
 * @param   signal          Stops the turn
 *
 * @return  The events of the turn
 *
 * @throws  ApiError  When the server refuses the message before answering
 */
export async function* streamTurn(
  content: string,
  conversationId: number | null,
  signal: AbortSignal,
): AsyncGenerator<TurnEvent> {
  const response = await request("/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content, ...(conversationId ? { conversationId } : {}) }),
    signal,
  });
  if (!response.ok || !response.body) {
    const payload = (await response.json().catch(() => null)) as {
      error?: string;
      message?: string;
    } | null;
    throw new ApiError(
      payload?.message ?? "No se pudo enviar el mensaje; vuelve a intentarlo",
      response.status,
      payload?.error ?? "unknown",
    );
  }

  for await (const { event, data } of readEvents(response.body)) {
    yield { type: event, ...(data as object) } as TurnEvent;
  }
}

// What the person reads while a tool runs; the CLI names them with the server prefix
const LABELS: Record<string, string> = {
  find_capability: "Buscando la herramienta indicada",
  run_capability: "Consultando los datos",
  search: "Buscando en los documentos",
  fetch: "Leyendo un documento",
  read_pdf: "Leyendo el PDF",
  calculate: "Calculando",
  filter_rows: "Filtrando el resultado",
};

/**
 * Names a tool for a person
 *
 * @param   name  Name as the stream gives it
 *
 * @return  A short label in Spanish
 */
export function toolLabel(name: string): string {
  const bare = name.replace(/^mcp__[^_]+__/, "");
  return LABELS[bare] ?? `Usando ${bare.replace(/_/g, " ")}`;
}

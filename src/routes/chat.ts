import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { RateLimitExceededError } from "../chat/rateLimit.js";
import {
  findConversation,
  latestMessages,
  listConversations,
  rateMessage,
  renameConversation,
} from "../chat/repository.js";
import { type ChatDependencies, type ChatEvent, type ChatUser, chatTurn } from "../chat/turn.js";

export type ChatRoutesOptions = Omit<ChatDependencies, "logger">;

const sendBody = z.object({
  content: z.string().trim().min(1).max(20_000),
  conversationId: z.number().int().positive().nullable().optional(),
});

const idParams = z.object({ id: z.coerce.number().int().positive() });

const renameBody = z.object({ title: z.string().trim().min(1).max(200) });

const rateBody = z.object({
  stars: z.number().int().min(1).max(5),
  comment: z.string().trim().max(2000).nullable().optional(),
});

/**
 * Writes one server-sent event
 *
 * @param   reply  Open reply
 * @param   event  Event name
 * @param   data   Payload
 */
function writeEvent(reply: FastifyReply, event: string, data: unknown): void {
  reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

/**
 * Maps a failed turn to what the person may see
 *
 * @param   error  Failure
 *
 * @return  Code and message in Spanish
 */
function failure(error: unknown): { error: string; message: string } {
  if (error instanceof RateLimitExceededError) {
    return { error: "rate_limited", message: error.message };
  }

  return { error: "chat_failed", message: "No pude responder en este momento. Intenta de nuevo." };
}

/**
 * Registers the chat routes: streamed and plain turns, conversations and ratings
 *
 * @param   app      Fastify instance
 * @param   options  Chat dependencies
 */
export default async function chatRoutes(
  app: FastifyInstance,
  options: ChatRoutesOptions,
): Promise<void> {
  const chatScope = { preHandler: [app.requireAuth, app.requireScope("chat.use")] };

  const userOf = (request: { authUser: ChatUser | null }): ChatUser => {
    const user = request.authUser;
    if (!user) {
      throw new Error("Ruta de chat sin usuario autenticado");
    }

    return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
  };

  app.post("/chat/stream", chatScope, async (request, reply) => {
    const body = sendBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }

    // writeHead goes straight to the socket, so headers set by plugins must be merged in
    reply.raw.writeHead(200, {
      ...(reply.getHeaders() as Record<string, string | number | string[]>),
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });

    const controller = new AbortController();
    const onClose = () => controller.abort();
    // The request emits close once its body is read; the response closes when the client leaves
    reply.raw.on("close", onClose);
    // Proxies drop idle connections while the model works between visible events
    const heartbeat = setInterval(() => reply.raw.write(": keepalive\n\n"), 15_000);

    try {
      const turn = chatTurn(
        { ...options, logger: request.log },
        userOf(request),
        body.data.content,
        body.data.conversationId ?? null,
        controller.signal,
      );

      for await (const event of turn) {
        if (controller.signal.aborted) {
          break;
        }

        const { type, ...data } = event;
        writeEvent(reply, type, data);
      }
    } catch (error) {
      if (!(error instanceof RateLimitExceededError)) {
        request.log.error({ err: error }, "chat stream failed");
      }

      writeEvent(reply, "error", failure(error));
    } finally {
      clearInterval(heartbeat);
      reply.raw.off("close", onClose);
      reply.raw.end();
    }

    return reply;
  });

  app.post("/chat/send", chatScope, async (request, reply) => {
    const body = sendBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }

    let done: Extract<ChatEvent, { type: "done" }> | null = null;
    let userMessageId = 0;

    try {
      const turn = chatTurn(
        { ...options, logger: request.log },
        userOf(request),
        body.data.content,
        body.data.conversationId ?? null,
      );

      for await (const event of turn) {
        if (event.type === "start") {
          userMessageId = event.userMessageId;
        } else if (event.type === "done") {
          done = event;
        }
      }
    } catch (error) {
      const code = error instanceof RateLimitExceededError ? 429 : 500;
      if (code === 500) {
        request.log.error({ err: error }, "chat send failed");
      }

      return reply.code(code).send({ ok: false, ...failure(error) });
    }

    if (!done) {
      return reply.code(500).send({ ok: false, ...failure(null) });
    }

    const { type: _type, ...data } = done;

    return { ok: true, data: { ...data, userMessageId } };
  });

  app.get("/chat/conversations", chatScope, async (request) => {
    const search = z.object({ q: z.string().trim().max(100).optional() }).parse(request.query).q;

    return { ok: true, data: await listConversations(options.db, userOf(request).id, search) };
  });

  app.get("/chat/conversations/:id", chatScope, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const userId = userOf(request).id;

    const conversation = await findConversation(options.db, id, userId);
    if (!conversation) {
      return reply.code(404).send({ ok: false, error: "not_found" });
    }

    return {
      ok: true,
      data: {
        id: conversation.id,
        title: conversation.title,
        messages: await latestMessages(options.db, id, userId, 200),
      },
    };
  });

  app.patch("/chat/conversations/:id", chatScope, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = renameBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }

    const renamed = await renameConversation(options.db, id, userOf(request).id, body.data.title);

    return renamed ? { ok: true } : reply.code(404).send({ ok: false, error: "not_found" });
  });

  app.post("/chat/messages/:id/rate", chatScope, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const body = rateBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }

    // A low rating without saying why cannot be acted on
    if (body.data.stars <= 2 && !body.data.comment) {
      return reply.code(400).send({
        ok: false,
        error: "comment_required",
        message: "Cuéntanos qué faltó o qué estuvo mal",
      });
    }

    const rated = await rateMessage(
      options.db,
      id,
      userOf(request).id,
      body.data.stars,
      body.data.comment ?? null,
    );

    return rated ? { ok: true } : reply.code(404).send({ ok: false, error: "not_found" });
  });
}

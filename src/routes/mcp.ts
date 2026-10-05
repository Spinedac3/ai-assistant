import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { hashToken } from "../auth/opaqueTokens.js";
import type { Database } from "../db/client.js";
import { accessTokens } from "../db/schema.js";
import { runInfo } from "../mcp/runTokens.js";
import { buildMcpServer, type McpCaller, type McpSettings } from "../mcp/server.js";
import { resolveUser } from "../permissions/resolve.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface McpRoutesOptions {
  db: Database;
  registry: ToolRegistry;
  settings: McpSettings;
  publicBaseUrl: string;
}

// Browser origins of the hosted clients; a client that is not a browser sends no Origin at all
const ALLOWED_ORIGINS = new Set(["https://claude.ai", "https://chatgpt.com"]);

// Twice the busiest minute a person is expected to need, and still far below what degrades the server
const MAX_CALLS_PER_MINUTE = 300;

const recentCalls = new Map<number, number[]>();

/**
 * Tells whether a user went over the per-minute call limit, counting this call
 *
 * @param   userId  Person calling
 *
 * @return  Whether the call must be refused
 */
export function overRate(userId: number): boolean {
  const now = Date.now();
  const calls = (recentCalls.get(userId) ?? []).filter((at) => now - at < 60_000);
  calls.push(now);
  recentCalls.set(userId, calls);

  if (recentCalls.size > 500) {
    for (const [id, times] of recentCalls) {
      if (times.every((at) => now - at >= 60_000)) {
        recentCalls.delete(id);
      }
    }
  }

  return calls.length > MAX_CALLS_PER_MINUTE;
}

/**
 * Tells whether a request's Origin may reach the MCP endpoint; the spec requires refusing others
 *
 * @param   origin         Origin header, if any
 * @param   publicBaseUrl  Public address of this server
 *
 * @return  Whether it is acceptable
 */
export function acceptableOrigin(origin: string | undefined, publicBaseUrl: string): boolean {
  if (!origin) {
    return true;
  }

  try {
    return ALLOWED_ORIGINS.has(origin) || new URL(origin).origin === new URL(publicBaseUrl).origin;
  } catch {
    return false;
  }
}

/**
 * Resolves the bearer token of a request to the caller and its channel
 *
 * @param   db       Own database
 * @param   request  Incoming request
 *
 * @return  The caller, "rate_limited", or null when the token is missing, unknown, expired or revoked
 */
async function resolveCaller(
  db: Database,
  request: FastifyRequest,
): Promise<McpCaller | "rate_limited" | null> {
  const header = request.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
  if (token === "") {
    return null;
  }

  const [row] = await db
    .select({
      id: accessTokens.id,
      userId: accessTokens.userId,
      kind: accessTokens.kind,
      createdAt: accessTokens.createdAt,
      lastUsedAt: accessTokens.lastUsedAt,
    })
    .from(accessTokens)
    .where(
      and(
        eq(accessTokens.accessTokenHash, hashToken(token)),
        isNull(accessTokens.revokedAt),
        gt(accessTokens.accessExpiresAt, sql`now()`),
      ),
    )
    .limit(1);

  if (!row) {
    return null;
  }

  const run = row.kind === "run" ? runInfo(token) : null;
  // A run token unknown to this process belongs to a run that died with a previous one
  if (row.kind === "run" && !run) {
    return null;
  }

  // Cheap refusals first, before resolving the person or writing anything
  if (overRate(row.userId)) {
    return "rate_limited";
  }

  const user = await resolveUser(db, row.userId);
  // Revoking a person's sessions must end MCP sessions too, refreshed or not. The cut-off is
  // stored in whole seconds, so a token born in that same second is revoked as well
  const bornAt = Math.floor(row.createdAt.getTime() / 1000) * 1000;
  if (!user?.active || (user.tokensRevokedAt && bornAt <= user.tokensRevokedAt.getTime())) {
    return null;
  }

  // Once a minute is enough to tell a live session from an abandoned one
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
    await db
      .update(accessTokens)
      .set({ lastUsedAt: sql`now()` })
      .where(eq(accessTokens.id, row.id));
  }

  return {
    userId: user.id,
    email: user.email,
    scopes: user.scopes,
    channel: run ? (run.tools === null ? "chat" : "run") : "external",
    runTools: run?.tools ?? [],
    conversationId: run?.conversationId,
    registry: run?.registry,
    trial: run?.trial,
  };
}

/**
 * Registers the MCP endpoint
 *
 * @param   app      Fastify instance
 * @param   options  Database, tool registry, settings and public address
 */
export default async function mcpRoutes(
  app: FastifyInstance,
  options: McpRoutesOptions,
): Promise<void> {
  const unauthorized = (reply: FastifyReply) =>
    reply
      .code(401)
      .header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${options.publicBaseUrl}/.well-known/oauth-protected-resource"`,
      )
      .send({ ok: false, error: "invalid_token" });

  app.post("/mcp", async (request, reply) => {
    // Before the token: a hijacked browser must not even cost a lookup
    if (!acceptableOrigin(request.headers.origin, options.publicBaseUrl)) {
      return reply.code(403).send({ ok: false, error: "origin_not_allowed" });
    }

    const caller = await resolveCaller(options.db, request);
    if (caller === "rate_limited") {
      return reply.code(429).header("Retry-After", "60").send({ ok: false, error: "rate_limited" });
    }

    if (!caller) {
      return unauthorized(reply);
    }

    const server = buildMcpServer(
      options.db,
      caller.registry ?? options.registry,
      caller,
      options.settings,
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    reply.hijack();
    reply.raw.on("close", () => {
      void transport.close();
      void server.close();
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(request.raw, reply.raw, request.body);
    } catch (error) {
      // Fastify can no longer answer a hijacked reply, so this one must, or the client hangs
      request.log.error({ err: error }, "mcp request failed");
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { "Content-Type": "application/json" });
      }
      reply.raw.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: { code: -32603, message: "Internal error" },
        }),
      );
    }
  });

  // Stateless: no server-to-client stream and no sessions to end
  const notAllowed = async (_request: FastifyRequest, reply: FastifyReply) =>
    reply.code(405).header("Allow", "POST").send({ ok: false, error: "method_not_allowed" });

  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
}

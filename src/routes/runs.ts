import { and, eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import { type MachineClient, machineClientOf } from "../auth/machineClients.js";
import { hashToken } from "../auth/opaqueTokens.js";
import type { Database } from "../db/client.js";
import { accessTokens } from "../db/schema.js";
import { mintRunToken, revokeRunToken } from "../mcp/runTokens.js";
import { resolveUser } from "../permissions/resolve.js";
import type { ToolRegistry } from "../tools/registry.js";

export interface RunsRoutesOptions {
  db: Database;
  registry: ToolRegistry;
  clients: Map<string, MachineClient>;
}

// A run never lasts longer than this; the system that asked revokes it as soon as it ends
const MAX_RUN_MINUTES = 60;

const issueBody = z
  .object({
    owner_id: z.number().int().positive(),
    tools: z.array(z.string().min(1).max(64)).min(1).max(200),
    minutes: z.number().int().min(1).max(MAX_RUN_MINUTES),
    run_id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
  })
  .strict();
const revokeBody = z.object({ token: z.string().min(1).max(200) }).strict();

/**
 * Registers the routes another system uses to run agents for a person: one token per run
 *
 * @param   app      Fastify instance
 * @param   options  Database, tools and the declared machine clients
 */
export default async function runsRoutes(
  app: FastifyInstance,
  options: RunsRoutesOptions,
): Promise<void> {
  const { db, registry, clients } = options;

  /**
   * Finds the machine client of a request, answering 401 when there is none
   *
   * @param   request  Incoming request
   * @param   reply    Reply, used to refuse
   *
   * @return  The client, or null once refused
   */
  const clientOf = (request: FastifyRequest, reply: FastifyReply): MachineClient | null => {
    const client = machineClientOf(request.headers.authorization, clients);
    if (!client) {
      reply
        .code(401)
        .header("www-authenticate", 'Basic realm="runs"')
        .send({ ok: false, error: "invalid_client", message: "Cliente de máquina no reconocido" });
    }

    return client;
  };

  // The system is trusted to ask for anyone, but never past what that person can use now
  app.post("/runs/tokens", async (request, reply) => {
    const client = clientOf(request, reply);
    if (!client) {
      return reply;
    }
    const body = issueBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_body",
        message: body.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
    }
    const { owner_id: ownerId, tools, minutes, run_id: runId } = body.data;
    const owner = await resolveUser(db, ownerId);
    if (!owner?.active) {
      return reply.code(404).send({
        ok: false,
        error: "owner_not_found",
        message: "La persona dueña del agente no existe o está desactivada",
      });
    }
    const usable = new Set(registry.visibleTo(owner.scopes).map((tool) => tool.name));
    const asked = [...new Set(tools)];
    const granted = asked.filter((tool) => usable.has(tool));
    const denied = asked.filter((tool) => !usable.has(tool));
    await logAudit(db, {
      userId: owner.id,
      level: granted.length > 0 ? "info" : "warn",
      eventCode: "run_token.issued",
      message: `Token de corrida pedido por ${client.clientId}`,
      systemCode: client.clientId,
      ip: request.ip,
      metadata: { run_id: runId, granted, denied, minutes },
    });
    if (granted.length === 0) {
      return reply.code(403).send({
        ok: false,
        error: "no_tools",
        message: "La persona dueña ya no puede usar ninguna de las herramientas del agente",
        data: { denied },
      });
    }
    const token = await mintRunToken(
      db,
      owner.id,
      minutes,
      { tools: granted, persisted: true },
      client.clientId,
    );

    return reply.code(201).send({
      ok: true,
      data: { token, tools: granted, denied, expires_in: minutes * 60 },
    });
  });

  // Only the system that asked for a token can end it
  app.post("/runs/tokens/revoke", async (request, reply) => {
    const client = clientOf(request, reply);
    if (!client) {
      return reply;
    }
    const body = revokeBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body", message: "Falta el token" });
    }
    const [own] = await db
      .select({ id: accessTokens.id })
      .from(accessTokens)
      .where(
        and(
          eq(accessTokens.accessTokenHash, hashToken(body.data.token)),
          eq(accessTokens.clientId, client.clientId),
          eq(accessTokens.kind, "run"),
        ),
      );
    if (!own) {
      return reply
        .code(404)
        .send({ ok: false, error: "token_not_found", message: "Ese token no es de este cliente" });
    }
    await revokeRunToken(db, body.data.token);

    return { ok: true };
  });
}

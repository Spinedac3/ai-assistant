import { eq } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import { type CheckResult, type Runner, runChecks, runnerFor } from "../creator/checks.js";
import { type BaseColumn, describeBase } from "../creator/columns.js";
import { definitionSchema, TOOL_NAME } from "../creator/definition.js";
import { guidePrompt, readGuide, unknownColumns } from "../creator/guide.js";
import { checkPasted } from "../creator/pasted.js";
import {
  type CreatedTools,
  findDefinition,
  publishDefinition,
  type StoredTool,
  saveDefinition,
  shapeOf,
} from "../creator/store.js";
import {
  type CreatedToolDependencies,
  descriptionOf,
  inputSchemaOf,
  outputSchemaOf,
  toolFrom,
} from "../creator/tool.js";
import type { Database } from "../db/client.js";
import { toolDefinitions } from "../db/schema.js";
import { oneAtATime } from "../lib/oneAtATime.js";
import { connectionFor, SOURCE_CODE, sourceScope } from "../sources/registry.js";
import { ToolRegistry } from "../tools/registry.js";

export interface ToolsRoutesOptions extends CreatedToolDependencies {
  db: Database;
  created: CreatedTools;
  // Asks the model one question with no tools; without it the guide is off
  ask?: (prompt: string) => Promise<string>;
}

// Values per column the guide sees, enough to tell what a column holds
const GUIDE_SAMPLES = 5;

// Checks read the base several times; each read gets the time a slow report would
const CHECK_LIMITS = { timeoutMs: 60_000, maxRows: 200_000 };

const nameParams = z.object({ name: z.string().regex(TOOL_NAME) });
const saveBody = z
  .object({ source: z.string().regex(SOURCE_CODE), definition: z.unknown() })
  .strict();
const runBody = z.object({ args: z.record(z.string(), z.unknown()).default({}) }).strict();
const guideBody = z.object({ question: z.string().trim().min(1).max(2_000).optional() }).strict();

/**
 * Registers the creator: tools defined over a registered source, saved as drafts, checked, tried
 * and published
 *
 * @param   app      Fastify instance
 * @param   options  Database, vault, zone of the application and the registry bridge
 */
export default async function toolsRoutes(
  app: FastifyInstance,
  options: ToolsRoutesOptions,
): Promise<void> {
  const { db, created } = options;
  const guard = { preHandler: [app.requireAuth, app.requireScope("tools.manage")] };

  /**
   * Loads a definition the caller may work on: it exists, and its source is one they may use
   *
   * @param   request  Request
   * @param   reply    Reply
   *
   * @return  The definition and its source's zone, or null once the reply is sent
   */
  const load = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ tool: StoredTool; zone: string | null } | null> => {
    const { name } = nameParams.parse(request.params);
    const found = await findDefinition(db, name);
    if (!found) {
      reply.code(404).send({ ok: false, error: "tool_not_found" });
      return null;
    }
    if (!request.authUser?.scopes.has(sourceScope(found.tool.sourceCode))) {
      reply.code(403).send({
        ok: false,
        error: "source_not_allowed",
        message: "No tienes el permiso de la fuente de esta herramienta",
      });
      return null;
    }

    return found;
  };

  /**
   * Runs the checks of a stored definition against its source
   *
   * @param   tool  Stored definition
   *
   * @return  The results, or why the source could not be reached
   */
  /**
   * Builds the runner that reads a stored tool's source as the tool would
   *
   * @param   tool  Stored definition
   *
   * @return  The runner, or why the source cannot be read
   */
  const runnerOf = async (tool: StoredTool): Promise<Runner | string> => {
    const source = await connectionFor(db, options.secrets, tool.sourceCode);
    if (!source) {
      return "La fuente ya no existe";
    }
    const pasted =
      tool.spec.base.kind === "query" ? checkPasted(tool.spec.base.sql, source.info.engine) : null;
    if (pasted && !pasted.ok) {
      return pasted.message;
    }

    const kinds = new Map(tool.columns.map((column) => [column.name, column.kind]));
    const limits = {
      ...CHECK_LIMITS,
      timeZone: tool.spec.time_zone ?? source.timeZone ?? options.appTimeZone,
    };

    return runnerFor(source.info, tool.spec.base, pasted?.sql ?? null, limits, kinds);
  };

  /**
   * Runs the checks of a stored definition against its source
   *
   * @param   tool  Stored definition
   *
   * @return  The results, or why the source could not be reached
   */
  const check = async (tool: StoredTool): Promise<CheckResult[]> => {
    const runner = await runnerOf(tool);
    if (typeof runner === "string") {
      return [{ name: "runs", ok: false, detail: runner }];
    }

    // Checks read the source several times; one set at a time per source keeps it answering
    return oneAtATime(`checks:${tool.sourceCode}`, () => runChecks(shapeOf(tool), runner));
  };

  app.get("/admin/tools", guard, async (request) => {
    const rows = await db.select().from(toolDefinitions).orderBy(toolDefinitions.name);
    // Only the tools over sources the caller may use
    const visible = rows.filter((row) => request.authUser?.scopes.has(sourceScope(row.sourceCode)));

    return {
      ok: true,
      data: visible.map((row) => ({
        name: row.name,
        source: row.sourceCode,
        status: row.status,
        updated_at: row.updatedAt,
        published_at: row.publishedAt,
      })),
    };
  });

  app.get("/admin/tools/:name", guard, async (request, reply) => {
    const found = await load(request, reply);
    if (!found) {
      return reply;
    }
    const { tool, zone } = found;
    const shaped = shapeOf(tool);

    return {
      ok: true,
      data: {
        name: tool.name,
        source: tool.sourceCode,
        status: tool.status,
        definition: tool.spec,
        columns: tool.columns,
        // What the model will read and send, so the person sees the tool as the model does
        description: descriptionOf(shaped, tool.spec.time_zone ?? zone ?? options.appTimeZone),
        input_schema: inputSchemaOf(shaped),
        output_schema: outputSchemaOf(shaped),
      },
    };
  });

  // Saving a published tool turns it back into a draft until it passes its checks again
  app.put("/admin/tools/:name", guard, async (request, reply) => {
    const { name } = nameParams.parse(request.params);
    const body = saveBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ ok: false, error: "invalid_body", message: body.error.issues[0]?.message });
    }
    if (created.isNative(name)) {
      return reply.code(409).send({
        ok: false,
        error: "name_taken",
        message: `${name} es una herramienta propia del asistente; usa otro nombre`,
      });
    }
    const parsed = definitionSchema.safeParse(body.data.definition);
    if (!parsed.success) {
      return reply.code(400).send({
        ok: false,
        error: "invalid_definition",
        message: parsed.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; "),
      });
    }
    const source = body.data.source;
    if (!request.authUser?.scopes.has(sourceScope(source))) {
      return reply.code(403).send({
        ok: false,
        error: "source_not_allowed",
        message: "No tienes el permiso de esa fuente",
      });
    }
    // A tool moves to another source only by being made again over it
    const existing = await findDefinition(db, name);
    if (existing && existing.tool.sourceCode !== source) {
      return reply.code(409).send({
        ok: false,
        error: "source_changed",
        message: "La herramienta ya existe sobre otra fuente; bórrala o usa otro nombre",
      });
    }

    const connection = await connectionFor(db, options.secrets, source);
    if (!connection) {
      return reply.code(404).send({ ok: false, error: "source_not_found" });
    }
    const spec = parsed.data;
    let pasted: string | null = null;
    if (spec.base.kind === "query") {
      const checked = checkPasted(spec.base.sql, connection.info.engine);
      if (!checked.ok) {
        return reply
          .code(400)
          .send({ ok: false, error: "invalid_query", message: checked.message });
      }
      pasted = checked.sql;
    }

    let columns: BaseColumn[];
    try {
      columns = await describeBase(connection.info, spec.base, pasted, CHECK_LIMITS);
    } catch (error) {
      request.log.warn({ err: error, tool: name }, "tool base could not be described");
      return reply.code(400).send({
        ok: false,
        error: "base_unreadable",
        message:
          "No se pudo leer la base de la herramienta en la fuente; revisa la tabla o la consulta",
      });
    }
    const unknown = unknownColumns(spec, columns);
    if (unknown.length > 0) {
      return reply.code(400).send({
        ok: false,
        error: "unknown_columns",
        message: `La base no tiene: ${unknown.join(", ")}`,
        columns: columns.map((column) => column.name),
      });
    }

    const userId = request.authUser.id;
    const stored = await saveDefinition(db, { name, sourceCode: source, spec, columns, userId });
    created.sync(stored, connection.timeZone);
    await logAudit(db, {
      userId,
      level: "info",
      eventCode: "tools.saved",
      message: `${name} sobre ${source}`,
      ip: request.ip,
    });

    return {
      ok: true,
      data: { name, status: stored.status, columns, checks: await check(stored) },
    };
  });

  // The guide only suggests: each chip is a whole definition the person saves with the usual PUT
  app.post("/admin/tools/:name/guide", guard, async (request, reply) => {
    const found = await load(request, reply);
    if (!found) {
      return reply;
    }
    const ask = options.ask;
    if (!ask) {
      return reply
        .code(503)
        .send({ ok: false, error: "guide_off", message: "La guía no está disponible" });
    }
    const body = guideBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }
    const runner = await runnerOf(found.tool);
    if (typeof runner === "string") {
      return reply.code(400).send({ ok: false, error: "source_unreadable", message: runner });
    }

    const tool = found.tool;
    try {
      const samples = await oneAtATime(`checks:${tool.sourceCode}`, async () => {
        const found: Record<string, unknown[]> = {};
        for (const column of tool.columns) {
          const rows = await runner.sample([column.name]);
          found[column.name] = [...new Set(rows.map((row) => row[column.name]))].slice(
            0,
            GUIDE_SAMPLES,
          );
        }
        return found;
      });
      const input = {
        spec: tool.spec,
        columns: tool.columns,
        samples,
        question: body.data.question,
      };

      return { ok: true, data: readGuide(await ask(guidePrompt(input)), input) };
    } catch (error) {
      request.log.warn({ err: error, tool: tool.name }, "tool guide failed");
      return reply.code(502).send({
        ok: false,
        error: "guide_failed",
        message: "La guía no pudo responder ahora; vuelve a intentarlo",
      });
    }
  });

  app.post("/admin/tools/:name/check", guard, async (request, reply) => {
    const found = await load(request, reply);
    if (!found) {
      return reply;
    }

    return { ok: true, data: await check(found.tool) };
  });

  // The draft runs through a registry of its own, on the same path a published tool takes
  app.post("/admin/tools/:name/run", guard, async (request, reply) => {
    const found = await load(request, reply);
    if (!found) {
      return reply;
    }
    const body = runBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }
    const user = request.authUser;
    if (!user) {
      return reply.code(401).send({ ok: false });
    }
    const { tool, zone } = found;
    const trial = new ToolRegistry(db);
    trial.useLogger(request.log);
    trial.register(toolFrom(shapeOf(tool), options, zone));
    const outcome = await trial.execute(
      tool.name,
      body.data.args,
      { userId: user.id, email: user.email, scopes: user.scopes },
      { origin: "chat", timeZone: options.appTimeZone },
    );

    return { ok: outcome.ok, data: JSON.parse(outcome.text) };
  });

  app.post("/admin/tools/:name/publish", guard, async (request, reply) => {
    const found = await load(request, reply);
    if (!found) {
      return reply;
    }
    const results = await check(found.tool);
    if (results.some((result) => !result.ok)) {
      return reply.code(409).send({
        ok: false,
        error: "checks_failed",
        message: "La herramienta no pasó sus chequeos; corrígela antes de publicarla",
        checks: results,
      });
    }

    const published = await publishDefinition(db, found.tool);
    if (!published) {
      return reply.code(409).send({
        ok: false,
        error: "changed_while_checking",
        message: "La herramienta cambió mientras se chequeaba; vuelve a publicarla",
      });
    }
    created.sync(published, found.zone);
    await logAudit(db, {
      userId: request.authUser?.id ?? null,
      level: "info",
      eventCode: "tools.published",
      message: found.tool.name,
      ip: request.ip,
    });

    return { ok: true, data: { name: found.tool.name, status: "published", checks: results } };
  });

  app.delete("/admin/tools/:name", guard, async (request, reply) => {
    const found = await load(request, reply);
    if (!found) {
      return reply;
    }

    await db.delete(toolDefinitions).where(eq(toolDefinitions.name, found.tool.name));
    created.drop(found.tool.name);
    await logAudit(db, {
      userId: request.authUser?.id ?? null,
      level: "info",
      eventCode: "tools.deleted",
      message: found.tool.name,
      ip: request.ip,
    });

    return { ok: true, data: { name: found.tool.name } };
  });
}

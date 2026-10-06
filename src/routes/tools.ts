import { and, desc, eq, isNull } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { logAudit } from "../audit.js";
import { chatMcpConfig } from "../chat/mcpConfig.js";
import {
  RateLimitExceededError,
  type Reservation,
  refundMessage,
  reserveMessage,
} from "../chat/rateLimit.js";
import { findConversation } from "../chat/repository.js";
import { type ChatDependencies, type ChatEvent, chatTurn } from "../chat/turn.js";
import {
  explainPrompt,
  filterPrompt,
  listRelations,
  readExplanation,
  readSuggestion,
  suggestPrompt,
} from "../creator/catalog.js";
import { type CheckResult, type Runner, runChecks, runnerFor } from "../creator/checks.js";
import { type BaseColumn, describeBase, normalizeRows } from "../creator/columns.js";
import {
  baseSchema,
  columnName,
  definitionSchema,
  FILTER_OPS,
  MAX_FILTER_VALUES,
  TOOL_NAME,
  VALUE_OPS,
} from "../creator/definition.js";
import { guidePrompt, readGuide, unknownColumns } from "../creator/guide.js";
import { checkPasted } from "../creator/pasted.js";
import { distinctQuery } from "../creator/sql.js";
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
import { conversations, messages, toolDefinitions } from "../db/schema.js";
import type { ExportStore } from "../exports/store.js";
import { removeHiddenDeep } from "../lib/hiddenText.js";
import { isRunning, oneAtATime } from "../lib/oneAtATime.js";
import { cliToolName } from "../mcp/names.js";
import { CHAT_CLI_ALLOWED } from "../mcp/surface.js";
import { type ColumnKind, runQuery } from "../sources/engines.js";
import { connectionFor, SOURCE_CODE, sourceScope } from "../sources/registry.js";
import { ToolRegistry } from "../tools/registry.js";

export interface ToolsRoutesOptions extends CreatedToolDependencies {
  db: Database;
  created: CreatedTools;
  // Where a direct run leaves the Excel of a long result
  exports?: ExportStore;
  // Asks the model one question with no tools; without it the guide is off
  ask?: (prompt: string) => Promise<string>;
  // What a trial chat needs: the chat's own settings, this server's /mcp, and the shared tools
  trial?: {
    chat: Omit<ChatDependencies, "db" | "logger" | "mcpConfig" | "trial">;
    mcpUrl: string;
    registry: ToolRegistry;
  };
}

// Values per column the guide sees, enough to tell what a column holds
const GUIDE_SAMPLES = 5;

// Checks read the base several times; each read gets the time a slow report would
const CHECK_LIMITS = { timeoutMs: 60_000, maxRows: 200_000 };
// Naming the columns reads no row, so anything longer is a base that will not answer
const DESCRIBE_LIMITS = { timeoutMs: 15_000, maxRows: 1 };
// A few rows to describe a base, read as the guide reads them
const DESCRIBE_SAMPLE_LIMITS = { timeoutMs: 15_000, maxRows: 50 };
// Listing a source's tables reads its catalog only
const RELATIONS_LIMITS = { timeoutMs: 15_000, maxRows: 5_000 };
const BASE_UNREADABLE = {
  ok: false,
  error: "base_unreadable",
  message: "No se pudo leer esa base en la fuente; revisa la tabla o la consulta",
};
// Said whenever a name cannot be used, so it never tells whether a tool of another source exists
const NAME_TAKEN = {
  ok: false,
  error: "name_taken",
  message: "Ya hay una herramienta con ese nombre; usa otro",
};

const nameParams = z.object({ name: z.string().regex(TOOL_NAME) });
const describeBody = z.object({ source: z.string().regex(SOURCE_CODE), base: baseSchema }).strict();
const relationsQuery = z.object({ source: z.string().regex(SOURCE_CODE) }).strict();
const filterHelpBody = z
  .object({
    source: z.string().regex(SOURCE_CODE),
    base: baseSchema,
    column: columnName,
    op: z.enum(FILTER_OPS),
    // What the person said the base holds, so the explanation speaks of the same thing
    about: z.string().trim().min(1).max(2_000).optional(),
  })
  .strict();

type FilterValue = string | number | boolean;

const suggestBody = z
  .object({
    about: z.string().trim().min(1).max(2_000),
    columns: z.array(columnName).min(1).max(200),
    groups: z.array(columnName).max(200).optional(),
  })
  .strict();
const saveBody = z
  .object({
    source: z.string().regex(SOURCE_CODE),
    definition: z.unknown(),
    // A new tool never replaces an existing one of the same name
    create: z.boolean().default(false),
  })
  .strict();
const runBody = z.object({ args: z.record(z.string(), z.unknown()).default({}) }).strict();
const guideBody = z.object({ question: z.string().trim().min(1).max(2_000).optional() }).strict();
const trialBody = z
  .object({
    message: z.string().trim().min(1).max(20_000),
    conversation_id: z.number().int().positive().optional(),
    // Only this tool, called directly, or the whole catalog with this tool in it
    scope: z.enum(["tool", "catalog"]).default("tool"),
  })
  .strict();
const trialParams = z.object({
  name: z.string().regex(TOOL_NAME),
  id: z.coerce.number().int().positive(),
});

/**
 * Reads the distinct values a column has in some rows, as text
 *
 * @param   rows    Rows
 * @param   column  Column
 *
 * @return  Its values, without repeats or empties
 */
function valuesOf(rows: Record<string, unknown>[], column: string): string[] {
  return [
    ...new Set(
      rows
        .map((row) => row[column])
        .filter((value) => value != null)
        .map((value) => (value instanceof Date ? value.toISOString() : String(value))),
    ),
  ];
}

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
    // A tool over a source the caller may not use does not exist for them, so its name is not told
    if (!request.authUser?.scopes.has(sourceScope(found.tool.sourceCode))) {
      reply.code(404).send({ ok: false, error: "tool_not_found" });
      return null;
    }

    return found;
  };

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

  /**
   * Opens a source the caller may build on: they hold its permission and it still exists
   *
   * @param   request  Request
   * @param   reply    Reply
   * @param   source   Code of the source
   *
   * @return  Its connection, or null once the reply is sent
   */
  const openSource = async (request: FastifyRequest, reply: FastifyReply, source: string) => {
    if (!request.authUser?.scopes.has(sourceScope(source))) {
      reply.code(403).send({
        ok: false,
        error: "source_not_allowed",
        message: "No tienes el permiso de esa fuente",
      });
      return null;
    }
    const connection = await connectionFor(db, options.secrets, source);
    if (!connection) {
      reply
        .code(404)
        .send({ ok: false, error: "source_not_found", message: "Esa fuente ya no existe" });
      return null;
    }

    return connection;
  };

  /**
   * Opens the base a person is choosing, before anything is saved: its source, and the pasted
   * query checked when the base is one
   *
   * @param   request  Request
   * @param   reply    Reply
   *
   * @return  The source, its connection, the base and the checked query, or null once replied
   */
  const openBase = async <T extends z.infer<typeof describeBody>>(
    request: FastifyRequest,
    reply: FastifyReply,
    schema: z.ZodType<T>,
  ) => {
    const body = schema.safeParse(request.body);
    if (!body.success) {
      reply
        .code(400)
        .send({ ok: false, error: "invalid_body", message: body.error.issues[0]?.message });
      return null;
    }
    const { source, base } = body.data;
    const connection = await openSource(request, reply, source);
    if (!connection) {
      return null;
    }
    let pasted: string | null = null;
    if (base.kind === "query") {
      const checked = checkPasted(base.sql, connection.info.engine);
      if (!checked.ok) {
        reply.code(400).send({ ok: false, error: "invalid_query", message: checked.message });
        return null;
      }
      pasted = checked.sql;
    }

    return { source, connection, base, pasted, body: body.data };
  };

  /**
   * Tells a person to wait when the same source is already being read, instead of queueing reads
   * that block the checks of everyone else
   *
   * @param   reply  Reply
   * @param   key    What is being read
   *
   * @return  Whether the reply was sent
   */
  const busy = (reply: FastifyReply, key: string): boolean => {
    if (!isRunning(key)) {
      return false;
    }
    reply.code(429).send({
      ok: false,
      error: "busy",
      message: "Ya se está leyendo esa fuente; espera un momento",
    });
    return true;
  };

  // The tables and views a person can build on, so they pick one instead of typing its name
  app.get("/admin/tools/relations", guard, async (request, reply) => {
    const query = relationsQuery.safeParse(request.query);
    if (!query.success) {
      return reply.code(400).send({ ok: false, error: "invalid_query_string" });
    }
    const { source } = query.data;
    const connection = await openSource(request, reply, source);
    if (!connection) {
      return reply;
    }
    const key = `relations:${source}`;
    if (busy(reply, key)) {
      return reply;
    }
    try {
      const relations = await oneAtATime(key, () =>
        listRelations(connection.info, RELATIONS_LIMITS),
      );
      return { ok: true, data: { relations } };
    } catch (error) {
      request.log.warn({ err: error, source }, "relations could not be listed");
      return reply.code(400).send({
        ok: false,
        error: "source_unreadable",
        message: "No se pudieron leer las tablas de esa fuente",
      });
    }
  });

  // The columns of a base before anything is saved, so a person picks them instead of typing them
  app.post("/admin/tools/describe", guard, async (request, reply) => {
    const opened = await openBase(request, reply, describeBody);
    if (!opened) {
      return reply;
    }
    const { source, connection, base, pasted } = opened;
    const key = `describe:${source}`;
    if (busy(reply, key)) {
      return reply;
    }
    try {
      // Reads no row: the source only says which columns the base has
      const columns = await oneAtATime(key, () =>
        describeBase(connection.info, base, pasted, DESCRIBE_LIMITS),
      );
      return { ok: true, data: { columns } };
    } catch (error) {
      request.log.warn({ err: error, source }, "base could not be described");
      return reply.code(400).send(BASE_UNREADABLE);
    }
  });

  // The columns of a base with a short description the model writes from a few of its values,
  // for a base whose database gives none; without the model, only the columns
  app.post("/admin/tools/explain", guard, async (request, reply) => {
    const opened = await openBase(request, reply, describeBody);
    if (!opened) {
      return reply;
    }
    const { source, connection, base, pasted } = opened;
    const key = `describe:${source}`;
    if (busy(reply, key)) {
      return reply;
    }
    const ask = options.ask;
    let read: { columns: BaseColumn[]; samples: Record<string, string[]> };
    try {
      // One read of the columns and one of a few rows, so the source is not held long
      read = await oneAtATime(key, async () => {
        const columns = await describeBase(connection.info, base, pasted, DESCRIBE_LIMITS);
        if (!ask) {
          return { columns, samples: {} };
        }
        const kinds = new Map(columns.map((column) => [column.name, column.kind]));
        const runner = runnerFor(connection.info, base, pasted, DESCRIBE_SAMPLE_LIMITS, kinds);
        const rows = await runner.sample(
          columns.map((column) => column.name),
          false,
        );
        const samples = Object.fromEntries(
          columns.map((column) => [
            column.name,
            valuesOf(rows, column.name).slice(0, GUIDE_SAMPLES),
          ]),
        );
        return { columns, samples };
      });
    } catch (error) {
      request.log.warn({ err: error, source }, "base could not be described");
      return reply.code(400).send(BASE_UNREADABLE);
    }
    const { columns, samples } = read;
    if (!ask) {
      return { ok: true, data: { columns, description: null } };
    }

    const userId = request.authUser?.id;
    let reservation: Reservation | null = null;
    try {
      // A call to the model counts as a message of the person, like a chat turn
      const limits = options.trial?.chat.limits;
      if (limits && userId !== undefined) {
        reservation = await reserveMessage(db, userId, limits, options.appTimeZone);
      }
      const name = base.kind === "table" ? base.name : null;
      const description = readExplanation(await ask(explainPrompt(name, columns, samples)));
      return { ok: true, data: { columns, description } };
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        return { ok: true, data: { columns, description: null, note: error.message } };
      }
      // The person did not get a description, so the message is theirs again
      if (reservation && userId !== undefined) {
        await refundMessage(db, userId, reservation).catch(() => undefined);
      }
      request.log.warn({ err: error, source }, "base description failed");
      // The columns still serve: the person writes the description themselves
      return {
        ok: true,
        data: {
          columns,
          description: null,
          note: "No se pudo escribir la descripción ahora; escríbela tú",
        },
      };
    }
  });

  // What a filter needs for the model to use it well: the column's real values, as a closed list
  // when they are few, and an explanation the model writes and the person reviews
  app.post("/admin/tools/filter-help", guard, async (request, reply) => {
    const opened = await openBase(request, reply, filterHelpBody);
    if (!opened) {
      return reply;
    }
    const { source, connection, base, pasted, body } = opened;
    const key = `describe:${source}`;
    if (busy(reply, key)) {
      return reply;
    }
    let read: { kind: ColumnKind; values: FilterValue[] } | null;
    try {
      read = await oneAtATime(key, async () => {
        const columns = await describeBase(connection.info, base, pasted, DESCRIBE_LIMITS);
        const kind = columns.find((column) => column.name === body.column)?.kind;
        if (!kind) {
          return null;
        }
        // One more than a closed list holds, to tell a short list from a long one
        const sql = distinctQuery(
          base,
          connection.info.engine,
          pasted,
          body.column,
          MAX_FILTER_VALUES + 1,
        );
        const rows = normalizeRows(
          await runQuery(connection.info, sql, [], {
            timeoutMs: DESCRIBE_SAMPLE_LIMITS.timeoutMs,
            maxRows: MAX_FILTER_VALUES + 1,
          }),
        );
        const values = rows
          .map((row) => row.value)
          .filter(
            (value): value is FilterValue =>
              typeof value === "string" || typeof value === "number" || typeof value === "boolean",
          );
        return { kind, values };
      });
    } catch (error) {
      request.log.warn({ err: error, source }, "filter values could not be read");
      return reply.code(400).send(BASE_UNREADABLE);
    }
    if (!read) {
      return reply.code(400).send({
        ok: false,
        error: "unknown_column",
        message: "Esa columna no está en lo que lee la herramienta",
      });
    }

    const { kind, values } = read;
    // A closed list makes sense for a few texts or numbers a person picks one of
    const closed =
      VALUE_OPS.has(body.op) &&
      (kind === "text" || kind === "number") &&
      values.length > 0 &&
      values.length <= MAX_FILTER_VALUES;
    const sorted = [...values].sort((a, b) =>
      typeof a === "number" && typeof b === "number" ? a - b : String(a).localeCompare(String(b)),
    );
    const help = {
      values: closed ? sorted : null,
      examples:
        !closed && (kind === "text" || kind === "number") && values.length > 0
          ? values.slice(0, 5)
          : null,
    };

    const ask = options.ask;
    if (!ask) {
      return { ok: true, data: { ...help, description: null } };
    }
    const userId = request.authUser?.id;
    let reservation: Reservation | null = null;
    try {
      // A call to the model counts as a message of the person, like a chat turn
      const limits = options.trial?.chat.limits;
      if (limits && userId !== undefined) {
        reservation = await reserveMessage(db, userId, limits, options.appTimeZone);
      }
      const prompt = filterPrompt({
        column: body.column,
        kind,
        op: body.op,
        about: body.about ?? null,
        values: values.slice(0, MAX_FILTER_VALUES),
      });
      return { ok: true, data: { ...help, description: readExplanation(await ask(prompt)) } };
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        return { ok: true, data: { ...help, description: null, note: error.message } };
      }
      // The person did not get an explanation, so the message is theirs again
      if (reservation && userId !== undefined) {
        await refundMessage(db, userId, reservation).catch(() => undefined);
      }
      request.log.warn({ err: error, source }, "filter explanation failed");
      return {
        ok: true,
        data: {
          ...help,
          description: null,
          note: "No se pudo escribir la explicación ahora; escríbela tú",
        },
      };
    }
  });

  // The last step's suggestions: a name, what a row is and other words for it; the person edits
  // them before saving, and nothing here reads the source
  app.post("/admin/tools/suggest", guard, async (request, reply) => {
    const body = suggestBody.safeParse(request.body);
    if (!body.success) {
      return reply
        .code(400)
        .send({ ok: false, error: "invalid_body", message: body.error.issues[0]?.message });
    }
    const ask = options.ask;
    if (!ask) {
      return { ok: true, data: { name: null, grain: null, synonyms: [] } };
    }
    const userId = request.authUser?.id;
    let reservation: Reservation | null = null;
    try {
      // A call to the model counts as a message of the person, like a chat turn
      const limits = options.trial?.chat.limits;
      if (limits && userId !== undefined) {
        reservation = await reserveMessage(db, userId, limits, options.appTimeZone);
      }
      const { about, columns, groups } = body.data;
      return {
        ok: true,
        data: readSuggestion(await ask(suggestPrompt(about, columns, groups ?? null))),
      };
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        return reply.code(429).send({ ok: false, error: "rate_limited", message: error.message });
      }
      if (reservation && userId !== undefined) {
        await refundMessage(db, userId, reservation).catch(() => undefined);
      }
      request.log.warn({ err: error }, "tool suggestion failed");
      // The person fills them in; nothing is lost
      return { ok: true, data: { name: null, grain: null, synonyms: [] } };
    }
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
    // Its texts become the description every model reads, so nothing hidden may stay in them
    const parsed = definitionSchema.safeParse(removeHiddenDeep(body.data.definition));
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
    if (existing && (body.data.create || existing.tool.sourceCode !== source)) {
      return reply.code(409).send(NAME_TAKEN);
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
    const userId = request.authUser?.id;
    let reservation: Reservation | null = null;
    try {
      // A call to the model counts as a message of the person, like a chat turn
      const limits = options.trial?.chat.limits;
      if (limits && userId !== undefined) {
        reservation = await reserveMessage(db, userId, limits, options.appTimeZone);
      }
      // One read of a few rows, whatever the number of columns, so the source is not held long;
      // only a column empty in those rows is read again on its own
      const samples = await oneAtATime(`checks:${tool.sourceCode}`, async () => {
        const rows = await runner.sample(
          tool.columns.map((column) => column.name),
          false,
        );
        const found: Record<string, string[]> = {};
        for (const column of tool.columns) {
          found[column.name] = valuesOf(rows, column.name);
          if (found[column.name]?.length === 0) {
            found[column.name] = valuesOf(await runner.sample([column.name], true), column.name);
          }
          found[column.name] = found[column.name]?.slice(0, GUIDE_SAMPLES) ?? [];
        }
        return found;
      });
      const input = {
        spec: tool.spec,
        columns: tool.columns,
        samples,
        question: body.data.question,
      };

      const read = readGuide(await ask(guidePrompt(input)), input);
      if (read.dropped > 0) {
        request.log.info({ tool: tool.name, dropped: read.dropped }, "guide chips dropped");
      }

      return { ok: true, data: read };
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        return reply.code(429).send({ ok: false, error: "rate_limited", message: error.message });
      }
      // The person did not get an answer, so the message is theirs again
      if (reservation && userId !== undefined) {
        await refundMessage(db, userId, reservation).catch(() => undefined);
      }
      request.log.warn({ err: error, tool: tool.name }, "tool guide failed");
      return reply.code(502).send({
        ok: false,
        error: "guide_failed",
        message: "La guía no pudo responder ahora; vuelve a intentarlo",
      });
    }
  });

  // A chat through the real MCP path, where only this person can reach the draft
  app.post("/admin/tools/:name/chat", guard, async (request, reply) => {
    const found = await load(request, reply);
    if (!found) {
      return reply;
    }
    const trial = options.trial;
    const user = request.authUser;
    if (!trial || !user) {
      return reply
        .code(503)
        .send({ ok: false, error: "trial_off", message: "El chat de prueba no está disponible" });
    }
    const body = trialBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ ok: false, error: "invalid_body" });
    }
    const conversationId = body.data.conversation_id ?? null;
    // A trial goes on only in a conversation of this tool and this person
    if (
      conversationId !== null &&
      !(await findConversation(db, conversationId, user.id, found.tool.name))
    ) {
      return reply.code(404).send({ ok: false, error: "conversation_not_found" });
    }
    const readable = await runnerOf(found.tool);
    if (typeof readable === "string") {
      return reply.code(400).send({ ok: false, error: "source_unreadable", message: readable });
    }

    const { tool, zone } = found;
    let tools: ToolRegistry;
    try {
      tools = trial.registry.with(toolFrom(shapeOf(tool), options, zone));
    } catch (error) {
      request.log.warn({ err: error, tool: tool.name }, "trial tool could not be built");
      return reply.code(400).send({
        ok: false,
        error: "invalid_definition",
        message: "La herramienta no se pudo armar; vuelve a guardarla",
      });
    }
    const only = body.data.scope === "tool";
    const deps: ChatDependencies = {
      ...trial.chat,
      db,
      logger: request.log,
      mcpConfig: chatMcpConfig(db, trial.mcpUrl, {
        tools: only ? [tool.name] : null,
        registry: tools,
        trial: true,
      }),
      trial: {
        toolName: tool.name,
        allowedTools: only ? cliToolName(tool.name) : CHAT_CLI_ALLOWED,
      },
    };

    let done: Extract<ChatEvent, { type: "done" }> | null = null;
    // A person who leaves stops the CLI, as in the chat
    const controller = new AbortController();
    const onClose = () => {
      if (!reply.raw.writableFinished) {
        controller.abort();
      }
    };
    reply.raw.on("close", onClose);
    try {
      for await (const event of chatTurn(
        deps,
        { id: user.id, email: user.email, displayName: user.displayName, role: user.role },
        body.data.message,
        conversationId,
        controller.signal,
      )) {
        if (event.type === "done") {
          done = event;
        }
      }
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        return reply.code(429).send({ ok: false, error: "rate_limited", message: error.message });
      }
      request.log.error({ err: error, tool: tool.name }, "trial chat failed");
      return reply
        .code(502)
        .send({ ok: false, error: "trial_failed", message: "El chat de prueba no respondió" });
    } finally {
      reply.raw.off("close", onClose);
    }
    if (!done) {
      return reply
        .code(502)
        .send({ ok: false, error: "trial_failed", message: "El chat de prueba no respondió" });
    }

    const [stored] = await db
      .select({ trace: messages.trace })
      .from(messages)
      .where(eq(messages.id, done.assistantMessageId));

    return {
      ok: true,
      data: {
        conversation_id: done.conversationId,
        answer: done.text,
        trace: stored?.trace ?? [],
        usage: done.usage,
      },
    };
  });

  app.get("/admin/tools/:name/chats", guard, async (request, reply) => {
    const found = await load(request, reply);
    if (!found) {
      return reply;
    }

    const rows = await db
      .select({ id: conversations.id, lastMessageAt: conversations.lastMessageAt })
      .from(conversations)
      .where(
        and(
          eq(conversations.toolName, found.tool.name),
          eq(conversations.userId, request.authUser?.id ?? 0),
          isNull(conversations.deletedAt),
        ),
      )
      .orderBy(desc(conversations.lastMessageAt));

    return {
      ok: true,
      data: rows.map((row) => ({ id: row.id, last_message_at: row.lastMessageAt })),
    };
  });

  app.get("/admin/tools/:name/chats/:id", guard, async (request, reply) => {
    const found = await load(request, reply);
    if (!found) {
      return reply;
    }
    const params = trialParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ ok: false, error: "invalid_id" });
    }
    const { id } = params.data;
    const conversation = await findConversation(db, id, request.authUser?.id ?? 0, found.tool.name);
    if (!conversation) {
      return reply.code(404).send({ ok: false, error: "conversation_not_found" });
    }

    const rows = await db
      .select({
        id: messages.id,
        role: messages.role,
        content: messages.content,
        trace: messages.trace,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(eq(messages.conversationId, id))
      .orderBy(messages.id);

    return { ok: true, data: rows.map((row) => ({ ...row, trace: row.trace ?? [] })) };
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
    if (options.exports) {
      trial.useExports(options.exports);
    }
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

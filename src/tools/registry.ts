import { createHash } from "node:crypto";
import { Ajv, type ValidateFunction } from "ajv";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/client.js";
import { toolCalls } from "../db/schema.js";
import type { ExportStore } from "../exports/store.js";
import { countHidden, removeHidden } from "../lib/hiddenText.js";
import {
  type Archive,
  CHAT_MAX_BYTES,
  capResult,
  EXTERNAL_MAX_BYTES,
  PROGRAM_MAX_BYTES,
  withCapFields,
} from "./cap.js";
import type { Tool, ToolDefinition, ToolOrigin } from "./contract.js";
import { applyFilter, filterable, filterHint, takeFilter } from "./filter.js";

// A failure of one tool is not a lack of capability; one reasoned alternative, never a sweep
export const FAILED_ROUTE_NOTE =
  "Falló ESTA herramienta, no necesariamente la capacidad de responder. Antes de decirle a la " +
  "persona que no puedes: si otra herramienta de tu catálogo responde LA MISMA pregunta, úsala. " +
  "Es UNA alternativa razonada, NO un barrido. Si ninguna responde exactamente lo pedido, di que " +
  "no puedes y que ya lo intentaste. NUNCA respondas con una fuente que contesta OTRA cosa.";

// A denial is not an outage: inviting another tool would be inviting a way around the control
export const DENIAL_NOTE =
  "No tienes permiso para esta capacidad. Dile a la persona que existe y que puede pedir acceso, " +
  "y ahí TERMINA tu respuesta: no busques otra herramienta ni respondas de memoria.";

// Arguments are audited to learn how tools are used; a long text, such as a whole document, only
// grows the table, so its length stands in for it
const AUDITED_TEXT_CHARS = 1_000;
// What a result may weigh for whoever reads it: a model in the chat or a trial, a client's model
// over MCP, or a program that reads it in code
const MAX_BYTES_OF: Record<ToolOrigin, number> = {
  chat: CHAT_MAX_BYTES,
  trial: CHAT_MAX_BYTES,
  mcp: EXTERNAL_MAX_BYTES,
  run: PROGRAM_MAX_BYTES,
};

/**
 * Prepares a call's arguments for the audit, keeping every key and the length of long texts
 *
 * @param   args  Arguments
 *
 * @return  What the audit stores
 */
export function auditedArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).map(([name, value]) => [
      name,
      typeof value === "string" && value.length > AUDITED_TEXT_CHARS
        ? `[${value.length} caracteres]`
        : value,
    ]),
  );
}

export interface Caller {
  userId: number;
  email: string;
  scopes: ReadonlySet<string>;
}

export interface CallContext {
  origin: ToolOrigin;
  conversationId?: number;
  timeZone: string;
}

export interface ToolOutcome {
  ok: boolean;
  // What the model reads
  text: string;
  // The same result as an object, for MCP clients and agent runs
  structured?: Record<string, unknown>;
}

/**
 * Tells whether a set of scopes passes a tool's gate
 *
 * @param   scopes      Effective scopes of the caller
 * @param   definition  Tool definition
 *
 * @return  Whether the caller may use the tool
 */
export function allowedBy(scopes: ReadonlySet<string>, definition: ToolDefinition): boolean {
  if (!definition.requiredScopes.every((scope) => scopes.has(scope))) {
    return false;
  }

  const anyOf = definition.requiredAnyScopes ?? [];

  return anyOf.length === 0 || anyOf.some((scope) => scopes.has(scope));
}

export class ToolRegistry {
  private readonly tools = new Map<string, Tool>();
  private readonly validators = new Map<
    string,
    { input: ValidateFunction; output?: ValidateFunction }
  >();
  private readonly ajv = new Ajv({ strict: false, allErrors: false });
  private logger?: FastifyBaseLogger;
  private exports?: ExportStore;

  /**
   * Builds an empty registry
   *
   * @param   db  Own database, for the call audit
   */
  constructor(private readonly db: Database) {}

  /**
   * Sets where failures and unusual results are reported, once the server's logger exists
   *
   * @param   logger  Server logger
   */
  useLogger(logger: FastifyBaseLogger): void {
    this.logger = logger;
  }

  /**
   * Sets where the detail that does not fit a result goes, once storage is ready
   *
   * @param   exports  Store of Excel files
   */
  useExports(exports: ExportStore): void {
    this.exports = exports;
  }

  /**
   * Builds the archive of one call; a storage failure only loses the file, never the answer
   *
   * @param   name    Tool name
   * @param   caller  Who runs it
   * @param   origin  Channel of the call
   *
   * @return  The archive, or null when there is no store
   */
  private archiveFor(name: string, caller: Caller, origin: ToolOrigin): Archive | null {
    const exports = this.exports;
    if (!exports) {
      return null;
    }

    return {
      save: async (sheets) => {
        try {
          // The panel's chats open it with the person's session; external clients and scheduled
          // runs hand the link to someone outside the panel
          return await exports.save(
            sheets,
            { userId: caller.userId, toolName: name },
            origin === "mcp" || origin === "run",
          );
        } catch (error) {
          this.logger?.error({ err: error, tool: name }, "result export failed");
          return null;
        }
      },
    };
  }

  /**
   * Adds a tool, compiling its schemas once
   *
   * @param   tool  Tool to add
   */
  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      throw new Error(`Tool duplicada: ${tool.definition.name}`);
    }

    this.replace(tool);
  }

  /**
   * Adds a tool or puts a new version in place of the one with its name, without a restart
   *
   * @param   tool  Tool to add
   */
  replace(tool: Tool): void {
    const { name, inputSchema, outputSchema } = tool.definition;
    this.tools.set(name, tool);
    this.validators.set(name, {
      input: this.ajv.compile(inputSchema),
      output: outputSchema ? this.ajv.compile(withCapFields(outputSchema)) : undefined,
    });
  }

  /**
   * Copies the registry with one more tool, or a new version of one, leaving this one untouched
   *
   * @param   tool  Tool the copy adds
   *
   * @return  The copy
   */
  with(tool: Tool): ToolRegistry {
    const copy = new ToolRegistry(this.db);
    copy.logger = this.logger;
    copy.exports = this.exports;
    for (const [name, existing] of this.tools) {
      copy.tools.set(name, existing);
      const validators = this.validators.get(name);
      if (validators) {
        copy.validators.set(name, validators);
      }
    }
    copy.replace(tool);

    return copy;
  }

  /**
   * Takes a tool out, so no path can call it from then on
   *
   * @param   name  Tool name
   */
  remove(name: string): void {
    this.tools.delete(name);
    this.validators.delete(name);
  }

  /**
   * Tells whether a tool with a name is registered
   *
   * @param   name  Tool name
   *
   * @return  Whether it is
   */
  has(name: string): boolean {
    return this.tools.has(name);
  }

  /**
   * Lists every registered tool definition
   *
   * @return  The definitions
   */
  all(): ToolDefinition[] {
    return [...this.tools.values()].map((tool) => tool.definition);
  }

  /**
   * Lists the definitions a set of scopes may use
   *
   * @param   scopes  Effective scopes of the caller
   *
   * @return  The visible definitions
   */
  visibleTo(scopes: ReadonlySet<string>): ToolDefinition[] {
    return this.all().filter((definition) => allowedBy(scopes, definition));
  }

  /**
   * Runs a tool through the one door every path shares: scope gate, input and output contracts,
   * hidden-text removal, the row filter, the size cap of its channel and the metadata audit
   *
   * @param   name     Tool to run
   * @param   args     Arguments from the model
   * @param   caller   Who runs it
   * @param   context  Path and conversation of the call
   *
   * @return  The outcome for the model and the client
   */
  async execute(
    name: string,
    args: Record<string, unknown>,
    caller: Caller,
    context: CallContext,
  ): Promise<ToolOutcome> {
    const started = Date.now();
    const tool = this.tools.get(name);

    if (!tool) {
      return this.fail(
        name,
        args,
        caller,
        context,
        started,
        "tool_not_found",
        `No existe la herramienta ${name}`,
      );
    }

    // The technical scope names never reach the model, which could repeat them to the person
    if (!allowedBy(caller.scopes, tool.definition)) {
      return this.fail(name, args, caller, context, started, "missing_scope", "Sin permiso");
    }

    // The row filter belongs to the registry, so every tool with a list gets it without knowing
    const request = takeFilter(args);
    if ("error" in request) {
      return this.fail(name, args, caller, context, started, "invalid_filter", request.error);
    }

    const validators = this.validators.get(name);
    if (validators && !validators.input(request.args)) {
      const detail = this.ajv.errorsText(validators.input.errors, { dataVar: "argumentos" });
      return this.fail(name, args, caller, context, started, "invalid_arguments", detail);
    }

    let result: Awaited<ReturnType<Tool["execute"]>>;
    try {
      result = await tool.execute(request.args, {
        userId: caller.userId,
        userEmail: caller.email,
        scopes: caller.scopes,
        conversationId: context.conversationId,
        origin: context.origin,
        timeZone: context.timeZone,
      });
    } catch (error) {
      this.logger?.error({ err: error, tool: name }, "tool threw");
      return this.fail(name, args, caller, context, started, "tool_failed", "La herramienta falló");
    }

    if (!result.ok) {
      return this.fail(name, args, caller, context, started, result.error, result.message);
    }

    // A result outside its declared shape breaks whoever reads its fields; fail loudly instead
    if (validators?.output && !validators.output(result.data)) {
      this.logger?.error(
        { tool: name, errors: validators.output.errors },
        "tool broke its output contract",
      );
      return this.fail(
        name,
        args,
        caller,
        context,
        started,
        "output_contract_broken",
        "La herramienta devolvió datos con otra forma",
      );
    }

    const raw = JSON.stringify(result.data);
    const hidden = countHidden(raw);
    if (hidden > 0) {
      this.logger?.warn({ tool: name, hidden }, "hidden unicode removed from a tool result");
    }

    // Cleaned before the size cap, so the Excel carries the same clean data the model reads
    const clean = JSON.parse(hidden > 0 ? removeHidden(raw) : raw) as Record<string, unknown>;

    // Filtered over every row before the cut, so what is counted is the whole list, not a sample
    const filtered = request.filter ? applyFilter(clean, request.filter) : null;
    if (filtered && !filtered.ok) {
      return this.fail(name, args, caller, context, started, "invalid_filter", filtered.message);
    }

    const target = filtered ? null : filterable(clean);
    const capped = await capResult(
      filtered ? filtered.data : clean,
      MAX_BYTES_OF[context.origin],
      this.archiveFor(name, caller, context.origin),
      target ? filterHint(target) : "",
      result.main,
    );
    if (!capped.ok) {
      return this.fail(name, args, caller, context, started, "result_too_large", capped.message);
    }
    // A program counts what it reads: a cut list would give it wrong totals without a word
    if (context.origin === "run" && capped.truncated) {
      return this.fail(
        name,
        args,
        caller,
        context,
        started,
        "result_too_large",
        `El resultado pasa de ${PROGRAM_MAX_BYTES / 1_000_000} MB: el programa necesita una consulta más angosta`,
      );
    }

    const text = JSON.stringify(capped.data);
    await this.audit(name, args, caller, context, started, {
      success: true,
      errorCode: null,
      text,
      rows: result.rows ?? null,
      truncated: result.truncated === true || capped.truncated,
    });

    // A cut result may no longer match its declared shape; then only the text goes out
    const outsideContract =
      capped.truncated && validators?.output !== undefined && !validators.output(capped.data);

    return { ok: true, text, structured: outsideContract ? undefined : capped.data };
  }

  /**
   * Builds a failed outcome with the note its kind of failure needs, and audits it
   *
   * @param   name      Tool name
   * @param   args      Arguments
   * @param   caller    Who ran it
   * @param   context   Path of the call
   * @param   started   Start time
   * @param   error     Machine-readable reason
   * @param   message   Reason in Spanish
   *
   * @return  The failed outcome
   */
  private async fail(
    name: string,
    args: Record<string, unknown>,
    caller: Caller,
    context: CallContext,
    started: number,
    error: string,
    message: string,
  ): Promise<ToolOutcome> {
    const envelope =
      error === "missing_scope"
        ? { error, message, terminal: true, note: DENIAL_NOTE }
        : { error, message, failed_route: FAILED_ROUTE_NOTE };
    const text = JSON.stringify(envelope);

    await this.audit(name, args, caller, context, started, {
      success: false,
      errorCode: error,
      text,
      rows: null,
      truncated: false,
    });

    return { ok: false, text };
  }

  /**
   * Records the metadata of a call; the result itself is never stored
   *
   * @param   name     Tool name
   * @param   args     Arguments
   * @param   caller   Who ran it
   * @param   context  Path of the call
   * @param   started  Start time
   * @param   outcome  What happened
   */
  private async audit(
    name: string,
    args: Record<string, unknown>,
    caller: Caller,
    context: CallContext,
    started: number,
    outcome: {
      success: boolean;
      errorCode: string | null;
      text: string;
      rows: number | null;
      truncated: boolean;
    },
  ): Promise<void> {
    try {
      await this.db.insert(toolCalls).values({
        userId: caller.userId,
        conversationId: context.conversationId ?? null,
        toolName: name,
        argsJson: auditedArgs(args),
        success: outcome.success,
        errorCode: outcome.errorCode,
        durationMs: Date.now() - started,
        resultBytes: Buffer.byteLength(outcome.text),
        resultRows: outcome.rows,
        truncated: outcome.truncated,
        resultHash: createHash("sha256").update(outcome.text).digest("hex"),
        origin: context.origin,
      });
    } catch (error) {
      // An audit failure never fails the call, but it must not pass unseen
      this.logger?.error({ err: error, tool: name }, "tool call audit failed");
    }
  }
}

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
  withCapFields,
} from "./cap.js";
import type { Tool, ToolDefinition, ToolOrigin } from "./contract.js";

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
   *
   * @return  The archive, or null when there is no store
   */
  private archiveFor(name: string, caller: Caller): Archive | null {
    const exports = this.exports;
    if (!exports) {
      return null;
    }

    return {
      save: async (sheets) => {
        try {
          return await exports.save(sheets, { userId: caller.userId, toolName: name });
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
    const { name, inputSchema, outputSchema } = tool.definition;
    if (this.tools.has(name)) {
      throw new Error(`Tool duplicada: ${name}`);
    }

    this.tools.set(name, tool);
    this.validators.set(name, {
      input: this.ajv.compile(inputSchema),
      output: outputSchema ? this.ajv.compile(withCapFields(outputSchema)) : undefined,
    });
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
   * hidden-text removal, the size cap of its channel and the metadata audit
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

    const validators = this.validators.get(name);
    if (validators && !validators.input(args)) {
      const detail = this.ajv.errorsText(validators.input.errors, { dataVar: "argumentos" });
      return this.fail(name, args, caller, context, started, "invalid_arguments", detail);
    }

    let result: Awaited<ReturnType<Tool["execute"]>>;
    try {
      result = await tool.execute(args, {
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
    const capped = await capResult(
      clean,
      context.origin === "mcp" ? EXTERNAL_MAX_BYTES : CHAT_MAX_BYTES,
      this.archiveFor(name, caller),
    );
    if (!capped.ok) {
      return this.fail(name, args, caller, context, started, "result_too_large", capped.message);
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
        argsJson: args,
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

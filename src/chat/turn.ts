import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyBaseLogger } from "fastify";
import type { Database } from "../db/client.js";
import { type CliCommand, cliArgs, launchCli } from "../llm/cli.js";
import { MCP_SERVER } from "../mcp/names.js";
import { readSetting } from "../settings.js";
import {
  claimsUnsourcedFigures,
  cutOffAnswer,
  finalAnswer,
  isHookRejection,
  isOnlyAnnouncement,
  isToolTheater,
  joinWithoutRepeats,
  NO_DATA,
  RETRY_DIRECTIVE,
  sealSources,
  type TurnEvent,
  threadSummary,
  trimLeadingNarration,
  turnBlocks,
} from "./guards.js";
import { chatInstructions, type PromptSettings } from "./prompt.js";
import { assertCanSend, type RateLimits, recordUsage } from "./rateLimit.js";
import { redactSecrets } from "./redact.js";
import { addMessage, createConversation, findConversation, latestMessages } from "./repository.js";
import { installSourceGate } from "./sourceGate.js";

// Enough to find a capability, run it and answer
const MAX_TURNS = 12;

// Past this context size a resumed thread stops answering, so the next turn starts a seeded session
const CONTEXT_CAP_TOKENS = 150_000;

// Built-in CLI tools a data assistant never needs; each attempt would only burn a step
export const DISALLOWED_CLI_TOOLS = [
  "Bash WebFetch WebSearch Agent Task Monitor",
  "Read Edit Write Glob Grep NotebookEdit",
  "Skill Workflow ReportFindings ScheduleWakeup SendMessage PushNotification",
  "RemoteTrigger EnterWorktree ExitWorktree",
  "CronCreate CronDelete CronList",
  "TaskCreate TaskGet TaskList TaskOutput TaskStop TaskUpdate",
].join(" ");

export interface ChatDependencies {
  db: Database;
  cli: CliCommand;
  model: string;
  workspacesDir: string;
  prompt: PromptSettings;
  limits: RateLimits;
  logger: FastifyBaseLogger;
  // Writes the turn's .mcp.json and returns how to release it; without it the turn has no tools
  mcpConfig?: (
    workspace: string,
    userId: number,
    conversationId: number,
  ) => Promise<() => Promise<void>>;
}

export interface ChatUser {
  id: number;
  email: string;
  displayName: string;
  role: string | null;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: number | null;
}

export type ChatEvent =
  | { type: "start"; conversationId: number; userMessageId: number }
  | { type: "delta"; text: string }
  | { type: "tool_call_pending"; id: string; name: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean }
  | {
      type: "done";
      conversationId: number;
      assistantMessageId: number;
      text: string;
      usage: TurnUsage;
      toolCallsExecuted: string[];
    };

interface CliOutcome {
  ok: boolean;
  resultText: string;
  cutByMaxTurns: boolean;
  model: string | null;
  context: number;
  tokensIn: number | null;
  tokensOut: number | null;
  cachedIn: number | null;
  costMillionths: number | null;
}

/**
 * Turns a CLI tool name into the name shown to people
 *
 * @param   name   Tool name as the CLI reports it
 * @param   input  Tool input, which names the capability for the run meta tool
 *
 * @return  The display name
 */
export function displayToolName(name: string, input: Record<string, unknown>): string {
  const base = name.replace(`mcp__${MCP_SERVER}__`, "");

  return typeof input.capability === "string" && input.capability !== "" ? input.capability : base;
}

/**
 * Runs one CLI process and yields what happens while it works
 *
 * @param   deps            Chat dependencies
 * @param   model           Model for this turn
 * @param   workspace       Conversation workspace
 * @param   prompt          Text sent to the CLI
 * @param   continueSession Whether to resume the workspace's session
 * @param   abortSignal     Stops the process
 *
 * @return  The turn's outcome once the process ends
 */
async function* runCli(
  deps: ChatDependencies,
  model: string,
  workspace: string,
  prompt: string,
  continueSession: boolean,
  abortSignal?: AbortSignal,
): AsyncGenerator<TurnEvent, CliOutcome> {
  const cli = launchCli(
    deps.cli,
    cliArgs({
      prompt,
      model,
      maxTurns: MAX_TURNS,
      continueSession,
      mcpConfigPath: join(workspace, ".mcp.json"),
      disallowedTools: DISALLOWED_CLI_TOOLS,
    }),
    workspace,
    abortSignal,
  );

  const outcome: CliOutcome = {
    ok: false,
    resultText: "",
    cutByMaxTurns: false,
    model: null,
    context: 0,
    tokensIn: null,
    tokensOut: null,
    cachedIn: null,
    costMillionths: null,
  };
  const count = (source: Record<string, unknown>, field: string) =>
    typeof source[field] === "number" ? (source[field] as number) : 0;

  for await (const event of cli.events) {
    if (event.type === "assistant") {
      const message = event.message as {
        content?: unknown[];
        usage?: Record<string, unknown>;
        model?: unknown;
      };
      if (typeof message?.model === "string" && message.model !== "") {
        outcome.model = message.model;
      }

      // The result event sums every call of the turn; the context is the largest single call
      const usage = message?.usage;
      if (usage) {
        outcome.context = Math.max(
          outcome.context,
          count(usage, "input_tokens") +
            count(usage, "cache_read_input_tokens") +
            count(usage, "cache_creation_input_tokens"),
        );
      }

      for (const block of (message?.content ?? []) as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
          yield { text: block.text };
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          const name = displayToolName(
            String(block.name ?? ""),
            (block.input ?? {}) as Record<string, unknown>,
          );
          yield { toolPending: { id: block.id, name } };
        }
      }
    } else if (event.type === "user") {
      const content = (event.message as { content?: unknown })?.content;
      if (isHookRejection(content)) {
        yield { rejected: true };
        continue;
      }

      for (const block of (Array.isArray(content) ? content : []) as Array<
        Record<string, unknown>
      >) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          yield { toolResult: { id: block.tool_use_id, ok: block.is_error !== true } };
        }
      }
    } else if (event.type === "result") {
      const usage = (event.usage ?? {}) as Record<string, unknown>;
      outcome.ok = event.is_error !== true;
      outcome.cutByMaxTurns = event.subtype === "error_max_turns";
      outcome.resultText = typeof event.result === "string" ? event.result : "";
      outcome.tokensIn = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
      outcome.tokensOut = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
      outcome.cachedIn =
        typeof usage.cache_read_input_tokens === "number" ? usage.cache_read_input_tokens : null;
      outcome.costMillionths =
        typeof event.total_cost_usd === "number"
          ? Math.round(event.total_cost_usd * 1_000_000)
          : null;
    }
  }

  await cli.closed;

  return outcome;
}

/**
 * Reads the context size the previous turn of a workspace measured
 *
 * @param   path  Measurement file
 *
 * @return  Tokens, or zero without a measurement
 */
function previousContext(path: string): number {
  try {
    return Number((JSON.parse(readFileSync(path, "utf8")) as { context?: unknown }).context) || 0;
  } catch {
    return 0;
  }
}

/**
 * Answers one chat message, streaming what happens and storing the final answer
 *
 * @param   deps            Chat dependencies
 * @param   user            Person writing
 * @param   rawContent      Message as written
 * @param   conversationId  Conversation to continue, or null for a new one
 * @param   abortSignal     Stops the turn when the client leaves
 *
 * @return  Stream of chat events
 */
export async function* chatTurn(
  deps: ChatDependencies,
  user: ChatUser,
  rawContent: string,
  conversationId: number | null,
  abortSignal?: AbortSignal,
): AsyncGenerator<ChatEvent, void> {
  const { db, logger } = deps;
  await assertCanSend(db, user.id, deps.limits, deps.prompt.timeZone);

  const content = redactSecrets(rawContent);
  const owned = conversationId ? await findConversation(db, conversationId, user.id) : null;
  const conversation = owned?.id ?? (await createConversation(db, user.id));
  const userMessageId = await addMessage(db, {
    conversationId: conversation,
    role: "user",
    content,
  });

  // Figures already in the thread are known, so a greeting after a figure is not an invention
  const earlier = (await latestMessages(db, conversation, user.id, 12)).filter(
    (message) => message.id !== userMessageId,
  );
  const known = [content, ...earlier.map((message) => message.content)].join("\n");

  yield { type: "start", conversationId: conversation, userMessageId };

  const workspace = join(deps.workspacesDir, String(conversation));
  const firstTurn = !existsSync(workspace);
  mkdirSync(workspace, { recursive: true });
  // Rewritten every turn: it carries today's date
  writeFileSync(join(workspace, "CLAUDE.md"), chatInstructions(user, deps.prompt, new Date()));
  installSourceGate(workspace);

  const contextPath = join(workspace, "context.json");
  const resetByContext = !firstTurn && previousContext(contextPath) > CONTEXT_CAP_TOKENS;
  let prompt = content;

  if (resetByContext) {
    const summary = threadSummary(earlier);
    prompt = summary ? `${summary}\n\n${content}` : content;
    logger.info({ conversationId: conversation }, "chat: context over the cap, seeded new session");
  }

  let release = async () => {};
  if (deps.mcpConfig) {
    release = await deps.mcpConfig(workspace, user.id, conversation);
  } else {
    writeFileSync(join(workspace, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
  }

  // Read every turn, so a change in administration applies to the next message
  const model = (await readSetting(db, "chat.model")) ?? deps.model;

  try {
    let retryingSilence = false;

    for (let attempt = 0; attempt < 2; attempt++) {
      // A silent turn is a rotten session: its retry starts fresh, never with --continue
      const resume = !retryingSilence && attempt === 0 && !firstTurn && !resetByContext;
      const names = new Map<string, string>();
      const executed: string[] = [];
      const seen: TurnEvent[] = [];
      let text = "";

      const run = runCli(deps, model, workspace, prompt, resume, abortSignal);
      let step = await run.next();

      while (!step.done) {
        const event = step.value;
        seen.push(event);

        if (event.text !== undefined) {
          text += (text === "" ? "" : "\n\n") + event.text;
          yield { type: "delta", text: event.text };
        } else if (event.toolPending) {
          names.set(event.toolPending.id, event.toolPending.name);
          yield { type: "tool_call_pending", ...event.toolPending };
        } else if (event.toolResult) {
          const name = names.get(event.toolResult.id) ?? "capacidad";
          if (event.toolResult.ok) {
            executed.push(name);
          }
          yield { type: "tool_result", id: event.toolResult.id, name, ok: event.toolResult.ok };
        }

        step = await run.next();
      }

      const outcome = step.value;
      const blocks = turnBlocks(seen);
      text = joinWithoutRepeats(blocks.all) || text;
      const afterTools = joinWithoutRepeats(blocks.afterTools);
      const usedTools = names.size > 0;

      // With no tool run, typed tool markup is worth nothing and is never stored
      const theater = !usedTools && isToolTheater(text);
      const cutOff = cutOffAnswer(outcome.cutByMaxTurns, blocks.afterTools);
      const candidate =
        cutOff ??
        (theater
          ? ""
          : trimLeadingNarration(
              (usedTools && afterTools !== "" ? afterTools : text || outcome.resultText).trim(),
            ));
      const unsourced = outcome.ok && claimsUnsourcedFigures(candidate, known, names.size);
      const answer = unsourced ? (attempt === 0 ? "" : NO_DATA) : candidate;
      const silent = outcome.ok && (answer === "" || (!usedTools && isOnlyAnnouncement(text)));

      if (attempt === 0 && silent && !abortSignal?.aborted) {
        logger.warn(
          { conversationId: conversation, theater, unsourced },
          "chat: silent turn, retrying",
        );
        retryingSilence = true;
        const summary = threadSummary(earlier);
        prompt = [RETRY_DIRECTIVE, ...(summary ? [summary] : []), content].join("\n\n");
        continue;
      }

      if (outcome.ok || text !== "" || cutOff !== null) {
        try {
          writeFileSync(contextPath, JSON.stringify({ context: outcome.context }));
        } catch {
          // Without a measurement the cap simply does not apply next turn
        }

        const stored = sealSources(finalAnswer(answer), executed);
        const assistantMessageId = await addMessage(db, {
          conversationId: conversation,
          role: "assistant",
          content: stored,
          tokensIn: outcome.tokensIn,
          tokensOut: outcome.tokensOut,
          costMillionths: outcome.costMillionths,
          model: outcome.model,
          finishReason: outcome.ok ? "stop" : "error",
        });
        await recordUsage(
          db,
          user.id,
          (outcome.tokensIn ?? 0) + (outcome.tokensOut ?? 0),
          outcome.costMillionths ?? 0,
          deps.prompt.timeZone,
        ).catch(() => undefined);

        yield {
          type: "done",
          conversationId: conversation,
          assistantMessageId,
          text: stored,
          usage: {
            inputTokens: outcome.tokensIn ?? 0,
            outputTokens: outcome.tokensOut ?? 0,
            cachedInputTokens: outcome.cachedIn ?? 0,
            costUsd: outcome.costMillionths === null ? null : outcome.costMillionths / 1_000_000,
          },
          toolCallsExecuted: executed,
        };

        return;
      }

      // The CLI keeps its sessions outside the workspace; a recreated host loses them
      if (attempt === 0 && resume && !abortSignal?.aborted) {
        logger.warn(
          { conversationId: conversation },
          "chat: --continue failed, retrying with a new session",
        );
        continue;
      }

      throw new Error("El motor de chat no devolvió respuesta");
    }
  } finally {
    await release().catch(() => undefined);
  }
}

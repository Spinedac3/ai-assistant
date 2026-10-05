import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CliCommand, cliArgs, DISALLOWED_CLI_TOOLS, launchCli } from "./cli.js";

export interface OneShotDependencies {
  cli: CliCommand;
  model: string;
  // Each call gets a folder of its own here, removed when it ends
  workspacesDir: string;
}

// One answer with no tools; past this the CLI is stuck, not thinking
const ONE_SHOT_TIMEOUT_MS = 120_000;
// The name an attached file takes in the call's folder; never the name its owner gave it
export const ATTACHMENT_NAME = "document.pdf";
// Reading a long PDF takes several reads of up to twenty pages each, then the answer
const ATTACHMENT_TURNS = 12;
// Reading a long PDF also takes longer than a plain answer
const ATTACHMENT_TIMEOUT_MS = 300_000;

/**
 * Asks the model one question and returns its answer. With no attachment it has no tools at
 * all; with one, it may only read that file
 *
 * @param   deps        CLI, model and where the call works
 * @param   prompt      Question, sent through stdin
 * @param   attachment  A file the model reads to answer
 *
 * @return  The text of the answer
 */
export async function askOnce(
  deps: OneShotDependencies,
  prompt: string,
  attachment?: Buffer,
): Promise<string> {
  // The chat creates this folder on its first turn; a call may come before any
  await mkdir(deps.workspacesDir, { recursive: true });
  const workspace = await mkdtemp(join(deps.workspacesDir, "one-shot-"));
  try {
    // No server at all: the model can only answer
    const mcpConfigPath = join(workspace, ".mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    if (attachment) {
      await writeFile(join(workspace, ATTACHMENT_NAME), attachment);
    }
    const args = cliArgs({
      model: deps.model,
      maxTurns: attachment ? ATTACHMENT_TURNS : 1,
      mcpConfigPath,
      // Read stays blocked unless there is a file, and then it reaches that file alone
      disallowedTools: attachment
        ? DISALLOWED_CLI_TOOLS.replace(/(^| )Read( |$)/, "$1")
        : DISALLOWED_CLI_TOOLS,
      ...(attachment ? { allowedTools: `Read(./${ATTACHMENT_NAME})` } : {}),
      // A list of what is allowed, so a tool a newer CLI adds is not left open
      tools: attachment ? "Read" : "",
    });
    const run = launchCli(
      deps.cli,
      args,
      prompt,
      workspace,
      AbortSignal.timeout(attachment ? ATTACHMENT_TIMEOUT_MS : ONE_SHOT_TIMEOUT_MS),
    );

    let answer: string | null = null;
    let failed = false;
    for await (const event of run.events) {
      if (event.type === "result") {
        answer = typeof event.result === "string" ? event.result : null;
        failed = event.is_error === true;
      }
    }
    await run.closed;
    if (failed || answer === null) {
      throw new Error("El modelo no respondió");
    }

    return answer;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

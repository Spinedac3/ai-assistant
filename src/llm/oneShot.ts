import { mkdtemp, rm, writeFile } from "node:fs/promises";
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

/**
 * Asks the model one question with no tools at all and returns its answer
 *
 * @param   deps    CLI, model and where the call works
 * @param   prompt  Question, sent through stdin
 *
 * @return  The text of the answer
 */
export async function askOnce(deps: OneShotDependencies, prompt: string): Promise<string> {
  const workspace = await mkdtemp(join(deps.workspacesDir, "one-shot-"));
  try {
    // No server at all: the model can only answer
    const mcpConfigPath = join(workspace, ".mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    const args = cliArgs({
      model: deps.model,
      maxTurns: 1,
      mcpConfigPath,
      disallowedTools: DISALLOWED_CLI_TOOLS,
    });
    const run = launchCli(
      deps.cli,
      args,
      prompt,
      workspace,
      AbortSignal.timeout(ONE_SHOT_TIMEOUT_MS),
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

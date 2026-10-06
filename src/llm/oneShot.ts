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

/**
 * Names the files of a call, as the model is told to read them
 *
 * @param   count  How many files
 *
 * @return  Their names in order: document.pdf alone, document-1.pdf and on when there are several
 */
export function attachmentNames(count: number): string[] {
  return count === 1
    ? [ATTACHMENT_NAME]
    : Array.from({ length: count }, (_, index) => `document-${index + 1}.pdf`);
}
// Reading a long PDF takes a read of each of its parts, then the answer
const ATTACHMENT_TURNS = 12;
// Reading a long PDF takes longer than a plain answer, yet well within the chat attempt that asked
// for it, so the attempt still has time to answer with what was read
const ATTACHMENT_TIMEOUT_MS = 180_000;

/**
 * Asks the model one question and returns its answer. With no attachment it has no tools at
 * all; with one, it may only read that file
 *
 * @param   deps        CLI, model and where the call works
 * @param   prompt      Question, sent through stdin
 * @param   attachment  The file the model reads to answer, or its parts in order
 * @param   limits      Turns and time for a longer job than reading a file to answer
 *
 * @return  The text of the answer
 */
export async function askOnce(
  deps: OneShotDependencies,
  prompt: string,
  attachment?: Buffer | Buffer[],
  limits?: { maxTurns: number; timeoutMs: number },
): Promise<string> {
  // The chat creates this folder on its first turn; a call may come before any
  await mkdir(deps.workspacesDir, { recursive: true });
  const workspace = await mkdtemp(join(deps.workspacesDir, "one-shot-"));
  try {
    // No server at all: the model can only answer
    const mcpConfigPath = join(workspace, ".mcp.json");
    await writeFile(mcpConfigPath, JSON.stringify({ mcpServers: {} }));
    const files =
      attachment === undefined ? [] : Array.isArray(attachment) ? attachment : [attachment];
    const names = attachmentNames(files.length);
    // With no file there is nothing to read, and Read stays blocked
    const reading = files.length > 0;
    for (const [index, file] of files.entries()) {
      await writeFile(join(workspace, names[index] ?? ATTACHMENT_NAME), file);
    }
    const args = cliArgs({
      model: deps.model,
      maxTurns: limits?.maxTurns ?? (reading ? ATTACHMENT_TURNS : 1),
      mcpConfigPath,
      // Read stays blocked unless there is a file, and then it reaches that file alone
      disallowedTools: reading
        ? DISALLOWED_CLI_TOOLS.split(" ")
            .filter((tool) => tool !== "Read")
            .join(" ")
        : DISALLOWED_CLI_TOOLS,
      ...(reading ? { allowedTools: names.map((name) => `Read(./${name})`).join(" ") } : {}),
      // A list of what is allowed, so a tool a newer CLI adds is not left open
      tools: reading ? "Read" : "",
      // Anything beyond that one read is denied, whatever the machine allows elsewhere
      permissionMode: "dontAsk",
    });
    const run = launchCli(
      deps.cli,
      args,
      prompt,
      workspace,
      AbortSignal.timeout(
        limits?.timeoutMs ?? (reading ? ATTACHMENT_TIMEOUT_MS : ONE_SHOT_TIMEOUT_MS),
      ),
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

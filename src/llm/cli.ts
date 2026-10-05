import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface CliCommand {
  bin: string;
  // Arguments placed before the CLI flags; lets tests run a fake CLI through node
  binArgs?: string[];
}

export interface ArgvOptions {
  prompt: string;
  model: string;
  maxTurns: number;
  mcpConfigPath: string;
  effort?: Effort;
  continueSession?: boolean;
  allowedTools?: string;
  disallowedTools: string;
}

export interface CliProcess {
  child: ChildProcess;
  events: AsyncGenerator<Record<string, unknown>, void>;
  closed: Promise<number | null>;
}

// Above this the prompt travels through stdin: Linux caps one argument and Windows the whole line
const STDIN_FROM = process.platform === "win32" ? 8_000 : 64_000;

// Only what the CLI needs to run and find its own login; nothing else of the server reaches it
const INHERITED_ENV = [
  "PATH",
  "HOME",
  "LANG",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "COMSPEC",
  "PATHEXT",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "TEMP",
  "TMP",
];

/**
 * Builds the environment of a CLI child from an allowlist, so no server secret is inherited
 *
 * @param   base  Environment of the server process
 *
 * @return  The child environment
 */
export function childEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const key of INHERITED_ENV) {
    if (base[key]) {
      env[key] = base[key];
    }
  }

  return env;
}

/**
 * Builds the CLI flags for one headless turn
 *
 * @param   options  Prompt, model and tool limits
 *
 * @return  The argument list
 */
export function cliArgs(options: ArgvOptions): string[] {
  return [
    "-p",
    options.prompt,
    // One event per line while it works; stream-json requires verbose
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    options.model,
    ...(options.effort ? ["--effort", options.effort] : []),
    "--max-turns",
    String(options.maxTurns),
    ...(options.continueSession ? ["--continue"] : []),
    // On a developer machine the child would load that developer's plugins, hooks and memory
    ...(process.platform === "win32" ? ["--setting-sources", "project,local"] : []),
    "--strict-mcp-config",
    "--mcp-config",
    options.mcpConfigPath,
    ...(options.allowedTools !== undefined ? ["--allowedTools", options.allowedTools] : []),
    "--disallowedTools",
    options.disallowedTools,
  ];
}

/**
 * Launches the CLI and yields its stream-json events in order
 *
 * @param   command      Binary to run
 * @param   args         CLI flags
 * @param   cwd          Workspace; stderr is written there
 * @param   abortSignal  Stops only this child
 *
 * @return  The process, its parsed events and its exit code
 */
export function launchCli(
  command: CliCommand,
  args: string[],
  cwd: string,
  abortSignal?: AbortSignal,
): CliProcess {
  const promptIndex = args.indexOf("-p");
  const prompt = promptIndex >= 0 ? args[promptIndex + 1] : undefined;
  const viaStdin = prompt !== undefined && prompt.length > STDIN_FROM;
  // An empty -p value tells the CLI to read the prompt from stdin
  const finalArgs = viaStdin
    ? [...args.slice(0, promptIndex + 1), ...args.slice(promptIndex + 2)]
    : args;

  // A file, not a pipe: reading only stdout can never block on a full stderr buffer
  const stderr = openSync(join(cwd, "stderr.log"), "w");
  const child = spawn(command.bin, [...(command.binArgs ?? []), ...finalArgs], {
    cwd,
    env: childEnv(process.env),
    stdio: [viaStdin ? "pipe" : "ignore", "pipe", stderr],
  });
  closeSync(stderr);

  if (viaStdin) {
    child.stdin?.end(prompt);
  }

  const onAbort = () => child.kill("SIGTERM");
  abortSignal?.addEventListener("abort", onAbort, { once: true });

  // A missing binary emits 'error'; unhandled, it would take the whole server down
  const closed = new Promise<number | null>((resolve, reject) => {
    child.on("close", resolve);
    child.on("error", reject);
  }).finally(() => abortSignal?.removeEventListener("abort", onAbort));
  closed.catch(() => undefined);

  async function* events() {
    if (!child.stdout) {
      return;
    }

    for await (const line of createInterface({ input: child.stdout })) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }

      try {
        yield JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        // The CLI sometimes prints non-JSON noise between events
      }
    }
  }

  return { child, events: events(), closed };
}

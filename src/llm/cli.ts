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

// Built-in CLI tools a data assistant never needs; each attempt would only burn a step
export const DISALLOWED_CLI_TOOLS = [
  "Bash WebFetch WebSearch Agent Task Monitor",
  "Read Edit Write Glob Grep NotebookEdit",
  "Skill Workflow ReportFindings ScheduleWakeup SendMessage PushNotification",
  "RemoteTrigger EnterWorktree ExitWorktree",
  "CronCreate CronDelete CronList",
  "TaskCreate TaskGet TaskList TaskOutput TaskStop TaskUpdate",
].join(" ");

const KILL_GRACE_MS = 5_000;

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
 * Builds the CLI flags for one headless turn; the prompt is never one of them
 *
 * @param   options  Model and tool limits
 *
 * @return  The argument list
 */
export function cliArgs(options: ArgvOptions): string[] {
  return [
    // Print mode with no prompt argument reads the prompt from stdin
    "-p",
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
 * @param   prompt       Text of the turn, sent through stdin
 * @param   cwd          Workspace; stderr is written there
 * @param   abortSignal  Stops only this child
 *
 * @return  The process, its parsed events and its exit code
 */
export function launchCli(
  command: CliCommand,
  args: string[],
  prompt: string,
  cwd: string,
  abortSignal?: AbortSignal,
): CliProcess {
  // A file, not a pipe: reading only stdout can never block on a full stderr buffer
  const stderr = openSync(join(cwd, "stderr.log"), "w");
  // The person's text never reaches the argument list: one starting with "--" would be read as a CLI option
  const child = spawn(command.bin, [...(command.binArgs ?? []), ...args], {
    cwd,
    env: childEnv(process.env),
    stdio: ["pipe", "pipe", stderr],
  });
  closeSync(stderr);
  // A CLI that dies before reading breaks the pipe; unhandled, that error kills the whole server
  child.stdin?.on("error", () => undefined);
  child.stdin?.end(prompt);

  // A CLI that ignores SIGTERM would hold the conversation lock forever, so it gets SIGKILL after a grace
  const onAbort = () => {
    child.kill("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }, KILL_GRACE_MS).unref();
  };
  if (abortSignal?.aborted) {
    onAbort();
  }
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

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/chat/redact.js";
import { childEnv, cliArgs, launchCli } from "../../src/llm/cli.js";

describe("cli", () => {
  it("never passes server secrets to the CLI child", () => {
    // Performs the test.
    const env = childEnv({
      PATH: "/usr/bin",
      HOME: "/home/app",
      DATABASE_URL: "postgres://assistant:secret@db/assistant",
      JWT_PRIVATE_KEY_FILE: "/run/secrets/jwt",
      SOURCES_KEK_FILE: "/run/secrets/kek",
      ANTHROPIC_API_KEY: "sk-ant-should-not-leak",
    });

    // Performs assertions.
    expect(env).toEqual({ PATH: "/usr/bin", HOME: "/home/app" });
  });

  it("resumes the session only when asked", () => {
    // Performs the test.
    const base = {
      model: "sonnet",
      maxTurns: 12,
      mcpConfigPath: ".mcp.json",
      disallowedTools: "Bash",
    };

    // Performs assertions.
    expect(cliArgs({ ...base, resumeSession: "0c7e92ec-1824-479c-a425-300cc4d6c5d0" })).toEqual(
      expect.arrayContaining(["--resume", "0c7e92ec-1824-479c-a425-300cc4d6c5d0"]),
    );
    expect(cliArgs(base)).not.toContain("--continue");
    expect(cliArgs(base)).not.toContain("--continue");
  });

  it("always isolates the MCP servers to the workspace config", () => {
    // Performs the test.
    const args = cliArgs({
      model: "sonnet",
      maxTurns: 12,
      mcpConfigPath: "ws/.mcp.json",
      disallowedTools: "Bash",
    });

    // Performs assertions.
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--mcp-config") + 1]).toBe("ws/.mcp.json");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("12");
  });

  it("leaves -p without a value, so the prompt can only come through stdin", () => {
    // Performs the test.
    const args = cliArgs({
      model: "sonnet",
      maxTurns: 12,
      mcpConfigPath: "ws/.mcp.json",
      disallowedTools: "Bash",
    });

    // Performs assertions.
    expect(args[0]).toBe("-p");
    expect(args[1]?.startsWith("--")).toBe(true);
  });
});

describe("redact", () => {
  it("masks keys and tokens before storing a message", () => {
    // Performs the test.
    const text = redactSecrets(
      "mi llave es sk-ant-abcdefghijklmnopqrstuv y el token Bearer abc.def.ghi y ghp_123456789012345678901234567890123456",
    );

    // Performs assertions.
    expect(text).toBe(
      "mi llave es [REDACTED:anthropic-key] y el token [REDACTED:bearer] y [REDACTED:github-token]",
    );
  });
});

describe("launchCli", () => {
  it("fails the turn without taking the server down when the binary is missing", async () => {
    // Performs the test.
    const workspace = mkdtempSync(join(tmpdir(), "cli-missing-"));
    const cli = launchCli({ bin: join(workspace, "no-such-cli") }, ["-p"], "hola", workspace);
    const events: unknown[] = [];
    for await (const event of cli.events) {
      events.push(event);
    }

    // Performs assertions.
    await expect(cli.closed).rejects.toThrow();
    expect(events).toEqual([]);
  });

  it("survives a CLI that exits before reading the prompt", async () => {
    // Performs the test.
    const workspace = mkdtempSync(join(tmpdir(), "cli-early-exit-"));
    const cli = launchCli(
      { bin: process.execPath, binArgs: ["-e", "process.exit(0)"] },
      [],
      "x".repeat(2_000_000),
      workspace,
    );

    // Performs assertions.
    expect(await cli.closed).toBe(0);
  });
});

describe("launchCli abort", () => {
  it("kills a CLI that ignores the polite stop", async () => {
    // Performs the test.
    const workspace = mkdtempSync(join(tmpdir(), "cli-stubborn-"));
    const stop = new AbortController();
    const cli = launchCli(
      {
        bin: process.execPath,
        binArgs: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      },
      [],
      "hola",
      workspace,
      stop.signal,
    );
    setTimeout(() => stop.abort(), 200);
    await cli.closed.catch(() => undefined);

    // Performs assertions.
    expect(cli.child.exitCode !== null || cli.child.signalCode !== null).toBe(true);
  }, 15_000);
});

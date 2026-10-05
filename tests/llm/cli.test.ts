import { describe, expect, it } from "vitest";
import { redactSecrets } from "../../src/chat/redact.js";
import { childEnv, cliArgs } from "../../src/llm/cli.js";

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
      prompt: "hola",
      model: "sonnet",
      maxTurns: 12,
      mcpConfigPath: ".mcp.json",
      disallowedTools: "Bash",
    };

    // Performs assertions.
    expect(cliArgs({ ...base, continueSession: true })).toContain("--continue");
    expect(cliArgs(base)).not.toContain("--continue");
  });

  it("always isolates the MCP servers to the workspace config", () => {
    // Performs the test.
    const args = cliArgs({
      prompt: "hola",
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

import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SOURCE_GATE_SCRIPT } from "../../src/chat/sourceGate.js";

const dir = mkdtempSync(join(tmpdir(), "source-gate-"));
const script = join(dir, "gate.cjs");
writeFileSync(script, SOURCE_GATE_SCRIPT);

/**
 * Runs the hook against a transcript and a final message
 *
 * @param   transcript  CLI transcript events
 * @param   answer      Last assistant message
 * @param   active      Whether the hook already blocked once
 *
 * @return  Exit code and output
 */
function gate(transcript: unknown[], answer: string, active = false) {
  const path = join(dir, `t-${Math.random()}.jsonl`);
  writeFileSync(path, transcript.map((event) => JSON.stringify(event)).join("\n"));

  const run = spawnSync(process.execPath, [script], {
    input: JSON.stringify({
      transcript_path: path,
      last_assistant_message: answer,
      stop_hook_active: active,
    }),
    encoding: "utf8",
  });

  return { code: run.status, reason: run.stdout ? JSON.parse(run.stdout).reason : "" };
}

const question = (text: string) => ({ type: "user", message: { content: text } });
const toolUse = {
  type: "assistant",
  message: { content: [{ type: "tool_use", name: "mcp__assistant__run_capability" }] },
};
const toolResult = (content: string) => ({
  type: "user",
  message: { content: [{ type: "tool_result", content }] },
});

describe("sourceGate", () => {
  it("blocks figures stated without running any tool", () => {
    // Performs the test.
    const result = gate([question("¿cuántos envíos hubo hoy?")], "Hubo 312 envíos.");

    // Performs assertions.
    expect(result.code).toBe(2);
    expect(result.reason).toContain("sin haber ejecutado ninguna herramienta");
  });

  it("lets through figures that a tool returned, even reformatted", () => {
    // Performs the test.
    const result = gate(
      [question("¿cuántos envíos?"), toolUse, toolResult('{"total":13808}')],
      "Hubo 13,808 envíos.",
    );

    // Performs assertions.
    expect(result.code).toBe(0);
  });

  it("blocks a figure added on top of what the tool returned", () => {
    // Performs the test.
    const result = gate(
      [question("¿cuántos envíos?"), toolUse, toolResult('{"total":142}')],
      "Hubo 142 envíos y 20 con daño.",
    );

    // Performs assertions.
    expect(result.code).toBe(2);
    expect(result.reason).toContain("(20)");
  });

  it("accepts a figure already said in an earlier turn", () => {
    // Performs the test.
    const transcript = [
      question("¿el pedido 501229?"),
      toolUse,
      toolResult('{"pedido":501229}'),
      question("hola"),
    ];

    // Performs assertions.
    expect(gate(transcript, "Hola, seguimos con el 501229.").code).toBe(0);
  });

  it("blocks typed tool markup", () => {
    // Performs assertions.
    expect(gate([question("¿y hoy?")], '<invoke name="run_capability">').code).toBe(2);
  });

  it("blocks only once and then lets the turn close", () => {
    // Performs assertions.
    expect(gate([question("¿cuántos?")], "Hubo 312.", true).code).toBe(0);
  });
});

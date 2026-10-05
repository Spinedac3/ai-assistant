import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { askOnce } from "../../src/llm/oneShot.js";

const fakeCli = join(import.meta.dirname, "..", "support", "fakeCli.mjs");

/**
 * Prepares a folder with a scripted CLI run
 *
 * @param   runs  What the fake CLI replays
 *
 * @return  The folder, the scenario file and the workspaces folder
 */
async function scripted(runs: unknown[]) {
  const folder = await mkdtemp(join(tmpdir(), "one-shot-test-"));
  const scenario = join(folder, "scenario.json");
  await writeFile(scenario, JSON.stringify(runs));
  const workspacesDir = join(folder, "workspaces");
  await mkdir(workspacesDir);

  return { scenario, workspacesDir };
}

describe("one-shot call", () => {
  it("sends the question through stdin with no tools and one turn, and leaves nothing behind", async () => {
    // Performs the test.
    const { scenario, workspacesDir } = await scripted([{ result: '{"explanation":"ok"}' }]);
    const answer = await askOnce(
      {
        cli: { bin: process.execPath, binArgs: [fakeCli, scenario] },
        model: "sonnet",
        workspacesDir,
      },
      "--settings=evil ¿qué columnas conviene filtrar?",
    );
    const [call] = (await readFile(`${scenario}.calls`, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));

    // Performs assertions.
    expect(answer).toBe('{"explanation":"ok"}');
    expect(call.prompt).toBe("--settings=evil ¿qué columnas conviene filtrar?");
    expect(call.model).toBe("sonnet");
    expect(call.args).toContain("--strict-mcp-config");
    expect(call.args[call.args.indexOf("--max-turns") + 1]).toBe("1");
    expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
    expect(call.args).not.toContain("--settings=evil ¿qué columnas conviene filtrar?");
    expect(await readdir(workspacesDir)).toEqual([]);
  });

  it("fails loudly when the model answers with an error or not at all", async () => {
    // Performs the test.
    const failing = await scripted([{ result: "boom", error: true }]);
    const silent = await scripted([{ noResult: true }]);
    const ask = (setup: { scenario: string; workspacesDir: string }) =>
      askOnce(
        {
          cli: { bin: process.execPath, binArgs: [fakeCli, setup.scenario] },
          model: "sonnet",
          workspacesDir: setup.workspacesDir,
        },
        "hola",
      );

    // Performs assertions.
    await expect(ask(failing)).rejects.toThrow("El modelo no respondió");
    await expect(ask(silent)).rejects.toThrow("El modelo no respondió");
  });

  it("creates the folder of its calls when nothing has made it yet", async () => {
    // Performs the test.
    const { scenario, workspacesDir } = await scripted([{ result: "listo" }]);
    const missing = join(workspacesDir, "aun-no-existe");
    const answer = await askOnce(
      {
        cli: { bin: process.execPath, binArgs: [fakeCli, scenario] },
        model: "sonnet",
        workspacesDir: missing,
      },
      "hola",
    );

    // Performs assertions.
    expect(answer).toBe("listo");
    expect(await readdir(missing)).toEqual([]);
  });
});

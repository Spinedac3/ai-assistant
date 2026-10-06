import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { newTests } from "../../tools/harness/newTests.mjs";
import { ROOT } from "../architecture/support/source.js";

const HARNESS = join(ROOT, "tools", "harness");
const SPEC = [
  "## Eje 0 — Mapa de impacto de la cadena",
  "| pieza | ¿tocada? | qué cambia |",
  "|---|---|---|",
  "| **ai-assistant** | sí | la ruta nueva |",
  "| **agent-factory** | no | no consume esta ruta |",
  "## 6. Tests exigidos",
  "> Seam decisorio: GET /docs/conversions ⇒ la conversión de la persona y ninguna ajena",
  "## Mapa de decisiones",
  "**Duraderas: D1**",
  "- D1 DURADERA — dos conversiones por persona · revertir=cola ✓ · sorprende=sí ✓ · perdedora=una ✓",
  "## Retroalimentación al método (SDD)",
  "— sin hallazgos —",
].join("\n");

/**
 * Runs a script of the kit with bash
 *
 * @param   script  Script name
 * @param   args    Its arguments
 *
 * @return  Its exit code and what it printed
 */
function run(script: string, ...args: string[]): { code: number | null; out: string } {
  const result = spawnSync("bash", [join(HARNESS, script), ...args], { encoding: "utf8" });

  return { code: result.status, out: `${result.stdout}${result.stderr}` };
}

/**
 * Writes a file in a fresh temporary folder
 *
 * @param   name  File name
 * @param   text  Contents
 *
 * @return  Its path
 */
function scratch(name: string, text: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "kit-")), name);
  writeFileSync(path, text);

  return path;
}

describe("the flow's kit", () => {
  it("lets a spec with every required part through", () => {
    // Performs the test.
    const checked = run("spec-check.sh", scratch("spec.md", SPEC));

    // Performs assertions.
    expect(checked.out).toContain("spec-check: 0 violación(es)");
    expect(checked.code).toBe(0);
  });

  it("names every missing part of a spec, and a section that did not travel to the issue", () => {
    // Performs the test.
    const broken = SPEC.replace("| **agent-factory** | no | no consume esta ruta |\n", "")
      .replace(/> Seam decisorio:.*\n/, "")
      .replace("**Duraderas: D1**", "**Duraderas: D1 · D2**")
      .replace("## Retroalimentación al método (SDD)", "## Notas")
      .concat("\n- la columna [confirmar] con el dueño");
    const checked = run("spec-check.sh", scratch("spec.md", broken));
    const travelled = run(
      "spec-check.sh",
      scratch("draft.md", SPEC),
      scratch("dump.md", SPEC.replace("## Mapa de decisiones", "Mapa de decisiones")),
    );

    // Performs assertions.
    expect(checked.code).toBe(1);
    expect(checked.out.match(/^SP\d/gm)).toEqual(["SP1", "SP2", "SP4", "SP5", "SP8"]);
    expect(travelled.code).toBe(1);
    expect(travelled.out).toContain("SP6");
  });

  it("refuses to check a spec that is not there", () => {
    // Performs the test.
    const checked = run("spec-check.sh", join(tmpdir(), "no-existe.md"));

    // Performs assertions.
    expect(checked.code).toBe(2);
  });

  it("refuses an issue or a number that would write outside the specs folder", () => {
    // Performs the test.
    const spec = scratch("spec.md", SPEC);
    const receipt = run("recibo.sh", "rojo", "../../x-1", spec, "tests/a.test.ts");
    const dump = run("spec-dump.sh", "Spinedac3/ai-assistant", "../../x");

    // Performs assertions.
    expect(receipt.code).toBe(2);
    expect(receipt.out).toContain("issue inválido");
    expect(dump.code).toBe(2);
    expect(dump.out).toContain("uso: spec-dump.sh");
  });

  it("counts as new a test added under a repeated title, and one whose title it cannot find", () => {
    // Performs the test.
    const base = 'describe("a", () => { it("reads", () => {}); });';
    const now = [
      'describe("a", () => { it("reads", () => {}); });',
      // A title written as a template with a value, which the file never spells out
      'describe("b", () => { it("reads", () => {}); it(`keeps $' + "{n}`, () => {}); });",
      "it('writes', () => {});",
    ].join("\n");
    const fresh = newTests(
      [
        "t.test.ts::a > reads",
        "t.test.ts::b > reads",
        "t.test.ts::b > keeps 3",
        "t.test.ts::writes",
      ],
      () => base,
      () => now,
    );
    const untouched = newTests(
      ["t.test.ts::a > reads"],
      () => base,
      () => base,
    );

    // Performs assertions.
    expect(fresh).toEqual(["t.test.ts::b > reads", "t.test.ts::b > keeps 3", "t.test.ts::writes"]);
    expect(untouched).toEqual([]);
  });

  // It starts a whole vitest run of its own, so it gets more time than a unit test
  it("refuses a red phase where a listed test file did not run", () => {
    // Performs the test.
    const today = new Date().toISOString().slice(0, 10);
    const spec = scratch("issue.md", `---\nfetched_at: ${today}T00:00\n---\n\n${SPEC}`);
    const result = spawnSync(
      "bash",
      [
        join(HARNESS, "recibo.sh"),
        "rojo",
        "ai-assistant-1",
        spec,
        "tests/harness/noExiste.test.ts",
      ],
      {
        encoding: "utf8",
        cwd: ROOT,
        env: { ...process.env, RECIBO_CORRIDAS: mkdtempSync(join(tmpdir(), "runs-")) },
      },
    );

    // Performs assertions.
    expect(result.status).toBe(2);
    expect(`${result.stdout}${result.stderr}`).toContain("no corrieron");
  }, 60_000);

  it("cuts a dump fetched another day and lets today's through", () => {
    // Performs the test.
    const checked = run("recibo.sh", "autochequeo");

    // Performs assertions.
    expect(checked.out).toContain("autochequeo ok");
    expect(checked.code).toBe(0);
  });

  it("reads passed, failed and skipped tests from junit, and refuses a missing file", () => {
    // Performs the test.
    const xml = scratch(
      "junit.xml",
      [
        '<testsuites name="vitest tests">',
        '<testcase classname="tests/a.test.ts" name="a &gt; passes"></testcase>',
        '<testcase classname="tests/a.test.ts" name="a &gt; fails"><failure message="x"/></testcase>',
        '<testcase classname="tests/a.test.ts" name="a &gt; waits"><skipped/></testcase>',
        "</testsuites>",
      ].join("\n"),
    );
    const read = spawnSync("node", [join(HARNESS, "junit.mjs"), xml], { encoding: "utf8" });
    const missing = spawnSync("node", [join(HARNESS, "junit.mjs"), `${xml}.gone`], {
      encoding: "utf8",
    });

    // Performs assertions.
    expect(JSON.parse(read.stdout)).toEqual({
      tests: 2,
      failures: 1,
      failed: ["tests/a.test.ts::a > fails"],
      names: ["tests/a.test.ts::a > passes", "tests/a.test.ts::a > fails"],
      files: ["tests/a.test.ts"],
    });
    expect(missing.status).toBe(2);
    expect(JSON.parse(missing.stdout).error).toBe("no-junit");
  });
});

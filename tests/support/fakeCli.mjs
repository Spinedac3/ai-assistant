// Stands in for the claude CLI: replays one scripted run per invocation and logs its arguments.
// Usage: node fakeCli.mjs <scenario.json> <cli flags...>
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const [scenarioPath, ...args] = process.argv.slice(2);
const runs = JSON.parse(readFileSync(scenarioPath, "utf8"));
const counterPath = `${scenarioPath}.count`;
const index = existsSync(counterPath) ? Number(readFileSync(counterPath, "utf8")) : 0;
writeFileSync(counterPath, String(index + 1));

const promptAt = args.indexOf("-p");
appendFileSync(
  `${scenarioPath}.calls`,
  `${JSON.stringify({ continued: args.includes("--continue"), prompt: args[promptAt + 1] ?? "" })}\n`,
);

const run = runs[Math.min(index, runs.length - 1)];
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);

for (const step of run.steps ?? []) {
  if (step.text !== undefined) {
    emit({
      type: "assistant",
      message: { model: "fake-model", content: [{ type: "text", text: step.text }], usage: { input_tokens: run.context ?? 1000 } },
    });
  } else if (step.tool) {
    emit({ type: "assistant", message: { content: [{ type: "tool_use", id: step.id, name: step.tool, input: step.input ?? {} }] } });
    emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: step.id, is_error: step.ok === false }] } });
  }
}

emit({
  type: "result",
  is_error: run.error === true,
  subtype: run.subtype ?? "success",
  result: run.result ?? "",
  usage: { input_tokens: 100, output_tokens: 20 },
  total_cost_usd: 0.0012,
});

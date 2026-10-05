import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliToolName, FIND_CAPABILITY, MCP_SERVER, RUN_CAPABILITY } from "../mcp/names.js";
import { FIGURE_SOURCE, LIST_MARKER_SOURCE, TOOL_THEATER_SOURCE, wholeDate } from "./guards.js";

// The CLI has no forced tool choice; a Stop hook that exits 2 keeps the model in the same turn.
// It reads the trace, never the answer's claims: every figure must appear in the question, in a
// tool result of this turn or in an earlier turn; only the exact dates the server handed the model
// are exempt. The model's own tool arguments are not a source, or it could launder any number
// through one. It blocks once; the second time it lets the turn close and the outer guard decides.
// Plain CommonJS for node, kept as a string so builds carry it; its patterns come from the guards.
export const SOURCE_GATE_SCRIPT = String.raw`#!/usr/bin/env node
const fs = require("fs");
const path = require("path");
const THEATER = new RegExp(${JSON.stringify(TOOL_THEATER_SOURCE)}, "i");
const FIGURE = new RegExp(${JSON.stringify(FIGURE_SOURCE)}, "g");
const LIST_MARKER = new RegExp(${JSON.stringify(LIST_MARKER_SOURCE)}, "gm");
const PREFIX = "mcp__${MCP_SERVER}__";
let raw = "";
process.stdin.on("data", (chunk) => (raw += chunk));
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (input.stop_hook_active === true) process.exit(0);
  let lines = [];
  try { lines = fs.readFileSync(input.transcript_path, "utf8").split("\n"); } catch { process.exit(0); }
  let tools = 0;
  let sources = "";
  const earlier = new Set();
  let knownDates = [];
  try { knownDates = JSON.parse(fs.readFileSync(path.join(input.cwd || ".", ".claude", "known-dates.json"), "utf8")); } catch {}
  for (const line of lines) {
    if (!line.trim()) continue;
    let event; try { event = JSON.parse(line); } catch { continue; }
    const message = event && event.message;
    if (!message) continue;
    if (event.type === "user" && typeof message.content === "string") {
      for (const run of sources.match(/\d+/g) || []) earlier.add(run);
      tools = 0; sources = message.content; continue;
    }
    if (event.type === "user" && Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === "tool_result") sources += "\n" + JSON.stringify(block.content);
    }
    if (event.type === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) if (block.type === "tool_use" && typeof block.name === "string" && block.name.startsWith(PREFIX)) tools++;
    }
  }
  const text = String(input.last_assistant_message || "");
  const theater = tools === 0 && THEATER.test(text);
  // A figure is backed when each digit run appears inside a run of the sources; earlier turns count whole runs only
  const sourceRuns = sources.match(/\d+/g) || [];
  const backed = (figure) => figure.split(/[.,:/]+/).filter(Boolean).every((run) => earlier.has(run) || sourceRuns.some((source) => source.includes(run)));
  let remaining = text.replace(LIST_MARKER, "");
  for (const pattern of knownDates) remaining = remaining.replace(new RegExp(pattern, "g"), " ");
  const figures = (remaining.match(FIGURE) || []).map((figure) => figure.replace(/[.,:/]+$/, ""));
  const orphans = figures.filter((figure) => !backed(figure));
  if (!theater && orphans.length === 0) process.exit(0);
  const why = theater
    ? "escribiste llamadas a herramientas como texto en vez de ejecutarlas."
    : tools === 0
      ? "afirmaste cifras sin haber ejecutado ninguna herramienta."
      : "afirmaste cifras que NO están en los resultados de tus herramientas (" + orphans.slice(0, 5).join(", ") + ").";
  process.stdout.write(JSON.stringify({
    decision: "block",
    reason: "AVISO DEL ARNÉS: " + why +
      (tools === 0
        ? " Llama ${cliToolName(FIND_CAPABILITY)} y después ${cliToolName(RUN_CAPABILITY)} y responde con el dato real."
        : " Usa SOLO los números que devolvieron las herramientas, o consulta de nuevo con otros parámetros.") +
      " Si ninguna capacidad lo devuelve, dilo sin inventar ninguna cifra." +
      " La persona NO vio tu respuesta anterior ni este aviso: escribe la respuesta COMPLETA de nuevo, como si fuera" +
      " la primera, sin mencionar este aviso ni una respuesta previa.",
  }));
  process.exit(2);
});
`;

/**
 * Installs the source gate as a Stop hook in the workspace settings
 *
 * @param   workspace   CLI working directory
 * @param   knownDates  Exact spellings of the dates the server gives the model this turn
 */
export function installSourceGate(workspace: string, knownDates: readonly string[]): void {
  const dir = join(workspace, ".claude");
  mkdirSync(dir, { recursive: true });

  const script = join(dir, "source-gate.cjs");
  writeFileSync(script, SOURCE_GATE_SCRIPT);
  // Written as ready patterns: the script cannot hold the escaping, it would read as interpolation
  writeFileSync(
    join(dir, "known-dates.json"),
    JSON.stringify(knownDates.map((date) => wholeDate(date).source)),
  );
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${script}"` }] }] },
    }),
  );
}

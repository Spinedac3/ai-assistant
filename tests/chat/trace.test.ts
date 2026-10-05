import { describe, expect, it } from "vitest";
import { type TraceEntry, traceCall, traceResult } from "../../src/chat/trace.js";

describe("trial trace", () => {
  it("joins each call with its result, its size and the Excel the cap left in it", () => {
    // Performs the test.
    const trace: TraceEntry[] = [traceCall("a", "entregas", { ruta: ["R-Norte-1"] })];
    trace.push(traceCall("b", "entregas", { ruta: [] }));
    const data = JSON.stringify({
      filas: [],
      archivo: { url: "https://assistant.example.com/exports/abc?sig=s" },
    });
    const wrapped = `<tool_result name="entregas" trusted="false">\n${data}\n</tool_result>`;
    traceResult(trace, "a", [{ type: "text", text: wrapped }], true);
    traceResult(trace, "b", "argumentos inválidos", false);
    traceResult(trace, "nadie", "sin llamada", true);

    // Performs assertions.
    expect(trace[0]).toMatchObject({
      tool: "entregas",
      args: { ruta: ["R-Norte-1"] },
      ok: true,
      excel: "https://assistant.example.com/exports/abc?sig=s",
    });
    expect(trace[0]?.bytes).toBe(Buffer.byteLength(wrapped, "utf8"));
    expect(trace[1]).toMatchObject({ result: "argumentos inválidos", ok: false, excel: null });
  });
});

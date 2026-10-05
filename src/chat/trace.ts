export interface TraceEntry {
  id: string;
  tool: string;
  args: unknown;
  // What the model read back, as it read it
  result: string | null;
  ok: boolean | null;
  bytes: number | null;
  // Link to the Excel with the detail, when the result was cut
  excel: string | null;
}

/**
 * Starts the trace entry of a tool call when the model makes it
 *
 * @param   id     Call id
 * @param   tool   Tool name as shown to people
 * @param   input  Arguments the model sent
 *
 * @return  The entry, waiting for its result
 */
export function traceCall(id: string, tool: string, input: unknown): TraceEntry {
  return { id, tool, args: input ?? {}, result: null, ok: null, bytes: null, excel: null };
}

/**
 * Reads the text of a tool result as the CLI reports it: plain text or text blocks
 *
 * @param   content  Content of the result block
 *
 * @return  The text
 */
function resultText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }

  return (Array.isArray(content) ? content : [])
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("");
}

/**
 * Finds the link to the Excel in a result, which the cap writes into the data the model reads
 *
 * @param   text  Result text, possibly wrapped as untrusted data
 *
 * @return  The link, or null
 */
function excelLink(text: string): string | null {
  const json = text.replace(/^<tool_result[^>]*>\n?/, "").replace(/\n?<\/tool_result>$/, "");
  try {
    const url = (JSON.parse(json) as { archivo?: { url?: unknown } }).archivo?.url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Completes the trace entry of a call once its result comes back
 *
 * @param   trace    Entries of the turn
 * @param   id       Call id
 * @param   content  Content of the result block
 * @param   ok       Whether the call succeeded
 */
export function traceResult(trace: TraceEntry[], id: string, content: unknown, ok: boolean): void {
  const entry = trace.find((item) => item.id === id);
  if (!entry) {
    return;
  }

  const text = resultText(content);
  entry.result = text;
  entry.ok = ok;
  entry.bytes = Buffer.byteLength(text, "utf8");
  entry.excel = excelLink(text);
}

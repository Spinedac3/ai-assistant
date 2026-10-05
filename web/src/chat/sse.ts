export interface StreamEvent {
  event: string;
  data: unknown;
}

/**
 * Reads server-sent events from a response body: each block of lines ending in a blank line is
 * one event, and comment lines (the keepalives) are skipped
 *
 * @param   body  Body of the response
 *
 * @return  The events, in order
 */
export async function* readEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<StreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) {
      return;
    }
    // A character may be split between two chunks; stream mode keeps its first bytes for the next
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");

      let event = "message";
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).trimStart());
        }
      }
      if (data.length > 0) {
        yield { event, data: JSON.parse(data.join("\n")) };
      }
    }
  }
}

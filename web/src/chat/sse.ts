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
    // A character may be split between two chunks; stream mode keeps its first bytes for the next
    buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
    buffer = buffer.replace(/\r\n/g, "\n");
    let end = buffer.indexOf("\n\n");
    while (end >= 0) {
      const event = parseBlock(buffer.slice(0, end));
      buffer = buffer.slice(end + 2);
      end = buffer.indexOf("\n\n");
      if (event) {
        yield event;
      }
    }
    if (done) {
      // A last event the server closed without its blank line still counts
      const last = parseBlock(buffer);
      if (last) {
        yield last;
      }
      return;
    }
  }
}

/**
 * Reads one block of lines as an event
 *
 * @param   block  Lines of one event
 *
 * @return  The event, or null when it carries no data
 */
function parseBlock(block: string): StreamEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      // The format allows one space after the colon, and only that one is not part of the data
      const value = line.slice(5);
      data.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }

  return data.length > 0 ? { event, data: JSON.parse(data.join("\n")) } : null;
}

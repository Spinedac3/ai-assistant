import { describe, expect, it } from "vitest";
import { readEvents } from "./sse";

/**
 * Builds a body that arrives in the given pieces
 *
 * @param   pieces  Chunks as the network would cut them
 *
 * @return  The stream
 */
function body(pieces: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const piece of pieces) {
        controller.enqueue(encoder.encode(piece));
      }
      controller.close();
    },
  });
}

describe("server-sent events", () => {
  it("reads events cut anywhere by the network, and skips the keepalives", async () => {
    // Performs the test.
    const events = [];
    for await (const event of readEvents(
      body([
        'event: start\ndata: {"conversationId":4}\n\n: keep',
        "alive\n\nevent: delta\nda",
        'ta: {"text":"Hola"}\r\n\r\nevent: done\ndata: {"text":"Hola."}\n\n',
      ]),
    )) {
      events.push(event);
    }

    // Performs assertions.
    expect(events).toEqual([
      { event: "start", data: { conversationId: 4 } },
      { event: "delta", data: { text: "Hola" } },
      { event: "done", data: { text: "Hola." } },
    ]);
  });

  it("keeps a letter whole when the network cuts it in two", async () => {
    // Performs the test.
    const bytes = new TextEncoder().encode('event: delta\ndata: {"text":"año"}\n\n');
    const cut = bytes.indexOf(0xc3) + 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.slice(0, cut));
        controller.enqueue(bytes.slice(cut));
        controller.close();
      },
    });
    const events = [];
    for await (const event of readEvents(stream)) {
      events.push(event);
    }

    // Performs assertions.
    expect(events).toEqual([{ event: "delta", data: { text: "año" } }]);
  });
});

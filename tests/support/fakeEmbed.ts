import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

const DIMENSIONS = 1024;

/**
 * Embeds a text as a normalized bag of its words, so texts sharing words are close
 *
 * @param   text  Text
 *
 * @return  The vector
 */
export function fakeVector(text: string): number[] {
  const vector = new Array<number>(DIMENSIONS).fill(0);
  const words = text
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 2);

  for (const word of words) {
    const slot = createHash("sha256").update(word).digest().readUInt32BE(0) % DIMENSIONS;
    vector[slot] = (vector[slot] ?? 0) + 1;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;

  return vector.map((value) => value / norm);
}

export interface FakeEmbed {
  url: string;
  // Requests received, to tell whether the service was used
  calls: string[];
  close: () => Promise<void>;
}

/**
 * Starts an embedding service with the real API and deterministic vectors
 *
 * @return  Its address, its call log and a way to stop it
 */
export async function startFakeEmbed(): Promise<FakeEmbed> {
  const calls: string[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (part) => {
      body += part;
    });
    request.on("end", () => {
      calls.push(request.url ?? "");
      const parsed = JSON.parse(body || "{}") as { texts?: string[]; text?: string };
      const payload =
        request.url === "/embed"
          ? { vectors: (parsed.texts ?? []).map(fakeVector) }
          : { vector: fakeVector(parsed.text ?? "") };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(payload));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

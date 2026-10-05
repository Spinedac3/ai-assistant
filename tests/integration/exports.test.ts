import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { exportFiles, toolCalls } from "../../src/db/schema.js";
import { ExportStore } from "../../src/exports/store.js";
import { isMissing, s3Client } from "../../src/rag/storage.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { testSigner } from "../support/keys.js";
import { freshDatabase } from "./support/database.js";

const BASE = "https://assistant.example.com";
const STORAGE = {
  endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
  accessKey: process.env.S3_ACCESS_KEY ?? "assistant",
  secretKey: process.env.S3_SECRET_KEY ?? "assistant-secret",
  bucket: "documents-test",
};
const caller = { userId: 7, email: "ana@example.com", scopes: new Set(["chat.use"]) };

let database: DatabaseHandle;
let app: FastifyInstance;
let store: ExportStore;
let registry: ToolRegistry;

/**
 * Runs the big tool on a channel
 *
 * @param   origin  Channel
 *
 * @return  The parsed result
 */
async function runBig(origin: "chat" | "mcp") {
  const outcome = await registry.execute("pedidos_del_anio", {}, caller, {
    origin,
    timeZone: "UTC",
  });

  return JSON.parse(outcome.text) as Record<string, unknown>;
}

/**
 * Downloads a link through the app, as a browser would
 *
 * @param   url  Link from a result
 *
 * @return  The response
 */
function download(url: string) {
  return app.inject({ url: url.replace(BASE, "") });
}

describe("exports", () => {
  beforeAll(async () => {
    database = await freshDatabase();
    // The bucket would otherwise exist only if the document tests ran first
    const client = s3Client(STORAGE);
    if (!(await client.bucketExists(STORAGE.bucket))) {
      await client.makeBucket(STORAGE.bucket);
    }
    store = new ExportStore(database.db, STORAGE, randomBytes(32), BASE);
    registry = new ToolRegistry(database.db);
    registry.useExports(store);
    registry.register({
      definition: {
        name: "pedidos_del_anio",
        description: "Every order of the year with its customer.",
        inputSchema: { type: "object" },
        requiredScopes: ["chat.use"],
        readOnly: true,
      },
      execute: async () => ({
        ok: true,
        data: {
          total_pedidos: 3000,
          monto_total: 1234567.89,
          pedidos: Array.from({ length: 3000 }, (_, id) => ({
            id,
            cliente: `Cliente ${id % 40}`,
            total: id * 1.5,
          })),
        },
      }),
    });
    app = await buildApp({
      db: database.db,
      signer: testSigner(),
      systems: new Map(),
      exports: { exports: store },
    });
  });

  afterAll(async () => {
    await app.close();
    await database.close();
  });

  it("keeps the chat result small, totals intact, with a link to every row", async () => {
    // Performs the test.
    const result = await runBig("chat");
    const archived = result.archivo as { url: string; filas: Record<string, number> };
    const file = await download(archived.url);
    const [audit] = await database.db.select().from(toolCalls);

    // Performs assertions.
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(40_000);
    expect(result.total_pedidos).toBe(3000);
    expect(result.monto_total).toBe(1234567.89);
    expect(archived.filas).toEqual({ pedidos: 3000 });
    expect(String(result.nota)).toContain(archived.url);
    expect(file.statusCode).toBe(200);
    expect(file.headers["content-disposition"]).toMatch(/^attachment; filename="pedidos_del_anio-/);
    expect(file.rawPayload.subarray(0, 2).toString()).toBe("PK");
    expect(audit?.truncated).toBe(true);
  });

  it("gives external clients more room before cutting", async () => {
    // Performs the test.
    const chat = await runBig("chat");
    const external = await runBig("mcp");

    // Performs assertions.
    expect((external.pedidos as unknown[]).length).toBeGreaterThan(
      (chat.pedidos as unknown[]).length,
    );
  });

  it("refuses a link with a changed signature, expiry or id", async () => {
    // Performs the test.
    const { url } = (await runBig("chat")).archivo as { url: string };
    const link = new URL(url);
    const id = link.pathname.split("/").pop() ?? "";
    const exp = Number(link.searchParams.get("exp"));
    const forged = [
      `/exports/${id}?exp=${exp}&sig=${"A".repeat(43)}`,
      `/exports/${id}?exp=${exp + 86_400}&sig=${link.searchParams.get("sig")}`,
      `/exports/00000000-0000-4000-8000-000000000000?exp=${exp}&sig=${link.searchParams.get("sig")}`,
      `/exports/${id}`,
    ];
    const statuses = await Promise.all(
      forged.map(async (path) => (await app.inject({ url: path })).statusCode),
    );

    // Performs assertions.
    expect(statuses).toEqual([404, 404, 404, 404]);
  });

  it("stops serving and deletes a file once it expires", async () => {
    // Performs the test.
    const { url } = (await runBig("chat")).archivo as { url: string };
    const id = new URL(url).pathname.split("/").pop() ?? "";
    await database.db.update(exportFiles).set({ expiresAt: sql`now() - interval '1 second'` });
    const expired = await download(url);
    const purged = await store.purge();
    const left = await database.db.select().from(exportFiles);
    const file = await s3Client(STORAGE)
      .statObject(STORAGE.bucket, `exports/${id}.xlsx`)
      .then(() => "still there")
      .catch((error: unknown) => (isMissing(error) ? "gone" : "unknown"));

    // Performs assertions.
    expect(expired.statusCode).toBe(404);
    expect(purged).toBeGreaterThan(0);
    expect(left).toHaveLength(0);
    expect(file).toBe("gone");
  });

  it("keeps the row of a file the storage could not remove, for the next sweep", async () => {
    // Performs the test.
    const { url } = (await runBig("chat")).archivo as { url: string };
    const id = new URL(url).pathname.split("/").pop() ?? "";
    await database.db.update(exportFiles).set({ expiresAt: sql`now() - interval '1 second'` });
    const refusing = s3Client(STORAGE);
    refusing.removeObjects = (async (_bucket: string, keys: string[]) =>
      keys.map((Key) => ({
        Key,
        Code: "AccessDenied",
      }))) as unknown as typeof refusing.removeObjects;
    const purged = await new ExportStore(
      database.db,
      STORAGE,
      randomBytes(32),
      BASE,
      refusing,
    ).purge();
    const left = await database.db.select({ id: exportFiles.id }).from(exportFiles);
    await store.purge();

    // Performs assertions.
    expect(purged).toBe(0);
    expect(left.map((row) => row.id)).toEqual([id]);
  });

  it("keeps the structured result when the cut only adds the declared cap fields", async () => {
    // Performs the test.
    registry.register({
      definition: {
        name: "estricta",
        description: "Returns rows with a strict declared shape.",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { filas: { type: "array" } },
          additionalProperties: false,
        },
        requiredScopes: ["chat.use"],
        readOnly: true,
      },
      execute: async () => ({
        ok: true,
        data: { filas: Array.from({ length: 2_000 }, (_, id) => ({ id, texto: "x".repeat(40) })) },
      }),
    });
    const outcome = await registry.execute("estricta", {}, caller, {
      origin: "chat",
      timeZone: "UTC",
    });

    // Performs assertions.
    expect(outcome.ok).toBe(true);
    expect(outcome.structured?.archivo).toBeDefined();
    expect(JSON.parse(outcome.text).nota).toBeDefined();
  });

  it("sends only the text when a cut result no longer fits its declared shape", async () => {
    // Performs the test.
    registry.register({
      definition: {
        name: "minima",
        description: "Returns rows with a strict declared shape.",
        inputSchema: { type: "object" },
        outputSchema: {
          type: "object",
          properties: { filas: { type: "array", minItems: 2_000 } },
          additionalProperties: false,
        },
        requiredScopes: ["chat.use"],
        readOnly: true,
      },
      execute: async () => ({
        ok: true,
        data: { filas: Array.from({ length: 2_000 }, (_, id) => ({ id, texto: "x".repeat(40) })) },
      }),
    });
    const outcome = await registry.execute("minima", {}, caller, {
      origin: "chat",
      timeZone: "UTC",
    });

    // Performs assertions.
    expect(outcome.ok).toBe(true);
    expect(outcome.structured).toBeUndefined();
    expect(JSON.parse(outcome.text).nota).toBeDefined();
  });

  it("filters every row before the cut, and the tool never sees the filter", async () => {
    // Performs the test.
    const seen: Record<string, unknown>[] = [];
    registry.register({
      definition: {
        name: "pedidos_estrictos",
        description: "Every order of the year, with arguments checked strictly.",
        inputSchema: {
          type: "object",
          properties: { anio: { type: "number" } },
          additionalProperties: false,
        },
        requiredScopes: ["chat.use"],
        readOnly: true,
      },
      execute: async (args) => {
        seen.push(args);
        return {
          ok: true,
          data: {
            pedidos: Array.from({ length: 3000 }, (_, id) => ({
              id,
              cliente: `Cliente ${id % 40}`,
              total: id * 1.5,
            })),
          },
        };
      },
    });
    const run = (args: Record<string, unknown>) =>
      registry.execute("pedidos_estrictos", args, caller, { origin: "chat", timeZone: "UTC" });
    const cut = JSON.parse((await run({ anio: 2026 })).text);
    const one = JSON.parse(
      (
        await run({
          anio: 2026,
          filter_rows: JSON.stringify({
            where: [{ field: "cliente", op: "=", value: "Cliente 7" }],
            sum: ["total"],
          }),
        })
      ).text,
    );
    const bad = JSON.parse(
      (await run({ filter_rows: { where: [{ field: "x", op: "like" }] } })).text,
    );
    const unknown = JSON.parse(
      (await run({ filter_rows: { where: [{ field: "zona", op: "empty" }] } })).text,
    );

    // Performs assertions.
    expect(seen.every((args) => !("filter_rows" in args))).toBe(true);
    expect(cut.nota).toContain("filter_rows");
    expect(cut.nota).toContain("Columnas: id, cliente, total.");
    expect(one.filtro_filas).toMatchObject({ filas_antes: 3000, filas_despues: 75 });
    expect(one.pedidos).toHaveLength(75);
    expect(one.filtro_filas.sumas.total).toBe(
      Array.from({ length: 75 }, (_, index) => (7 + index * 40) * 1.5).reduce((a, b) => a + b, 0),
    );
    expect(bad.error).toBe("invalid_filter");
    expect(unknown.error).toBe("invalid_filter");
    expect(unknown.message).toContain("cliente");
  });
});

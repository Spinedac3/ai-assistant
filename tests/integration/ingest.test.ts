import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "../../src/db/client.js";
import { auditLogs, documentJobs, scopes } from "../../src/db/schema.js";
import { parseDocument } from "../../src/rag/document.js";
import { Embedder } from "../../src/rag/embeddings.js";
import type { Index } from "../../src/rag/ingest.js";
import { claimNext, runJob } from "../../src/rag/jobs.js";
import { Solr } from "../../src/rag/solr.js";
import { DocumentStorage } from "../../src/rag/storage.js";
import { searchTool } from "../../src/tools/native/documents.js";
import { INGEST, ingestTool } from "../../src/tools/native/ingest.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { type FakeEmbed, startFakeEmbed } from "../support/fakeEmbed.js";
import { createCores, dropCores } from "../support/solrCores.js";
import { freshDatabase } from "./support/database.js";

const SOLR_URL = process.env.SOLR_URL ?? "http://localhost:8983";
const silent = { info: () => {}, error: () => {} } as unknown as Parameters<
  typeof runJob
>[0]["logger"];
const manager = {
  userId: 1,
  email: "admin@example.com",
  scopes: new Set(["chat.use", "docs.manage", "docs.general.read", "docs.rrhh.read"]),
};
const reader = {
  userId: 2,
  email: "ana@example.com",
  scopes: new Set(["chat.use", "docs.general.read"]),
};
// Manages documents but reads only the general area
const outsider = {
  userId: 3,
  email: "luis@example.com",
  scopes: new Set(["chat.use", "docs.manage", "docs.general.read"]),
};
const fields = { doc_title: "Guía de bodega", doc_version: "V001", area: "general" };
const body =
  "# Bodega\n\n## Montacargas\n\nLa velocidad máxima del montacargas es de ocho kilómetros por hora.\n";

const HOUR = 3_600_000;

let database: DatabaseHandle;
let embed: FakeEmbed;
let index: Index;
let storage: DocumentStorage;
let registry: ToolRegistry;

/**
 * Calls the tool as a person would through the chat
 *
 * @param   args    Arguments
 * @param   caller  Who calls
 *
 * @return  The parsed result
 */
async function call(args: Record<string, unknown>, caller = manager) {
  const outcome = await registry.execute(INGEST, args, caller, { origin: "chat", timeZone: "UTC" });

  return JSON.parse(outcome.text);
}

/**
 * Indexes every queued document, as the worker would
 */
async function drainQueue(): Promise<void> {
  for (let job = await claimNext(database.db); job; job = await claimNext(database.db)) {
    await runJob({ db: database.db, storage, index, logger: silent }, job);
  }
}

describe("ingest_document", () => {
  beforeAll(async () => {
    embed = await startFakeEmbed();
    database = await freshDatabase();
    index = {
      solr: new Solr(SOLR_URL),
      embedder: new Embedder(embed.url),
      cores: await createCores(SOLR_URL, "ingest"),
    };
    storage = new DocumentStorage({
      endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
      accessKey: process.env.S3_ACCESS_KEY ?? "assistant",
      secretKey: process.env.S3_SECRET_KEY ?? "assistant-secret",
      bucket: "documents-test",
    });
    await storage.ensureBucket();
    await database.db
      .insert(scopes)
      .values({ code: "docs.rrhh.read", description: "Leer documentos de RRHH" });

    registry = new ToolRegistry(database.db);
    registry.register(searchTool(index));
    registry.register(ingestTool({ db: database.db, index, storage }));
  });

  afterAll(async () => {
    await dropCores(SOLR_URL, index.cores);
    await embed.close();
    await database.close();
  });

  it("lets only docs.manage load documents", async () => {
    // Performs the test.
    const refused = await call({ mode: "validate" }, reader);

    // Performs assertions.
    expect(refused.error).toBe("missing_scope");
  });

  it("says what is missing, what is wrong and which areas exist", async () => {
    // Performs the test.
    const checked = await call({ mode: "validate", doc_code: "GUIA-BODEGA-V001", area: "ventas" });

    // Performs assertions.
    expect(checked.missing.map((item: { field: string }) => item.field)).toEqual([
      "doc_title",
      "doc_version",
    ]);
    expect(checked.invalid.map((item: { field: string }) => item.field)).toEqual(["area"]);
    expect(checked.areas).toEqual(expect.arrayContaining(["general", "rrhh"]));
    expect(checked.current_version).toBeNull();
    expect(checked.conversion.length).toBeGreaterThan(0);
  });

  it("stores, queues and indexes a document the search then finds", async () => {
    // Performs the test.
    const queued = await call({
      mode: "ingest",
      doc_code: "GUIA-BODEGA-V001",
      ...fields,
      markdown: body,
    });
    await drainQueue();
    const status = await call({ mode: "status", job_id: queued.job_id });
    const found = await registry.execute("search", { query: "velocidad del montacargas" }, reader, {
      origin: "chat",
      timeZone: "UTC",
    });
    const again = await call({ mode: "validate", doc_code: "GUIA-BODEGA-V002" });

    // Performs assertions.
    expect(queued.result).toBe("queued");
    expect(status).toMatchObject({ status: "done", doc_code: "GUIA-BODEGA-V001" });
    expect(status.chunks).toBeGreaterThan(0);
    expect(found.text).toContain("GUIA-BODEGA-V001");
    expect(again.current_version).toMatchObject({ doc_code: "GUIA-BODEGA-V001", same_code: false });
  });

  it("gathers a document sent in parts, in any order, and leaves no part behind", async () => {
    // Performs the test.
    const code = "MANUAL-RUTAS-V001";
    // The bucket outlives a test run; parts left by an earlier one must not join this one
    await storage.removeParts(manager.userId, code);
    await storage.removeParts(outsider.userId, code);
    const send = (part: number, text: string, caller = manager) =>
      call({ mode: "ingest", doc_code: code, ...fields, markdown: text, part, parts: 3 }, caller);
    const second = await send(2, "# Dos\n\nborrador");
    const first = await send(1, "# Uno\n\nPrimera parte.");
    const resent = await send(2, "# Dos\n\nSegunda parte.");
    // Someone else's part of the same code never joins this upload
    await send(3, "# Ajeno\n\nde otra persona.", outsider);
    const third = await send(3, "# Tres\n\nTercera parte.");
    const stored = parseDocument(await storage.readMarkdown(code));
    const left = (owner: number) => storage.partsReceived({ owner, docCode: code, parts: 3 }, HOUR);

    // Performs assertions.
    expect(second).toMatchObject({ result: "part_received", pending_parts: [1, 3] });
    expect(first).toMatchObject({ result: "part_received", pending_parts: [3] });
    expect(resent).toMatchObject({ result: "part_received", pending_parts: [3] });
    expect(third).toMatchObject({ result: "queued", parts: 3 });
    expect(stored.body).toBe(
      "# Uno\n\nPrimera parte.\n\n# Dos\n\nSegunda parte.\n\n# Tres\n\nTercera parte.",
    );
    expect(await left(manager.userId)).toEqual([]);
    expect((await left(outsider.userId)).map((item) => item.part)).toEqual([3]);
  });

  it("keeps an attempt split differently apart, and gathers parts sent at once only once", async () => {
    // Performs the test.
    const code = "MANUAL-FLOTA-V001";
    await storage.removeParts(manager.userId, code);
    const send = (part: number, parts: number, text: string) =>
      call({ mode: "ingest", doc_code: code, ...fields, markdown: text, part, parts });
    await send(2, 3, "# Viejo\n\nde un intento en tres partes.");
    const parallel = await Promise.all([
      send(1, 2, "# Uno\n\nNuevo."),
      send(2, 2, "# Dos\n\nNuevo."),
    ]);
    const stored = parseDocument(await storage.readMarkdown(code));
    const jobs = await database.db.select().from(documentJobs);

    // Performs assertions.
    expect(parallel.filter((outcome) => outcome.result === "queued")).toHaveLength(1);
    expect(parallel.some((outcome) => outcome.error)).toBe(false);
    expect(stored.body).toBe("# Uno\n\nNuevo.\n\n# Dos\n\nNuevo.");
    expect(jobs.filter((job) => job.docCode === code)).toHaveLength(1);
  });

  it("refuses parts past the size of an upload as soon as they pass it", async () => {
    // Performs the test.
    const code = "ENORME-V001";
    await storage.removeParts(manager.userId, code);
    // Each part within the limit of a call; six of them pass the limit of a document
    const piece = "x".repeat(390_000);
    const send = (part: number) =>
      call({ mode: "ingest", doc_code: code, ...fields, markdown: piece, part, parts: 30 });
    const outcomes = [];
    for (const part of [1, 2, 3, 4, 5, 6]) {
      outcomes.push(await send(part));
    }

    // Performs assertions.
    expect(outcomes.slice(0, 5).every((outcome) => outcome.result === "part_received")).toBe(true);
    expect(outcomes[5].error).toBe("too_large");
    expect(
      await storage.partsReceived({ owner: manager.userId, docCode: code, parts: 30 }, HOUR),
    ).toEqual([]);
  });

  it("forgets the parts of an attempt left unfinished, by the storage's own clock", async () => {
    // Performs the test.
    const upload = { owner: manager.userId, docCode: "OLVIDADO-V001", parts: 2 };
    await storage.removeParts(upload.owner, upload.docCode);
    await storage.savePart(upload, 1, "# Uno");
    await new Promise((resolve) => setTimeout(resolve, 1_100));
    await storage.savePart(upload, 2, "# Dos");
    // A lifetime shorter than the gap: the older part belongs to an abandoned attempt
    const received = await storage.partsReceived(upload, 500);

    // Performs assertions.
    expect(received.map((item) => item.part)).toEqual([2]);
    expect((await storage.partsReceived(upload, HOUR)).map((item) => item.part)).toEqual([2]);
  });

  it("lets nobody publish over, move, describe or follow a document of an area they do not read", async () => {
    // Performs the test.
    const salaries = { ...fields, area: "rrhh", markdown: body };
    const created = await call({ mode: "ingest", doc_code: "SALARIOS-V001", ...salaries });
    await drainQueue();
    const publish = await call(
      { mode: "ingest", doc_code: "SALARIOS-V002", ...salaries },
      outsider,
    );
    // From an area they read, over a family that lives in one they do not
    const supersede = await call(
      { mode: "ingest", doc_code: "SALARIOS-V002", ...fields, markdown: body },
      outsider,
    );
    const overwrite = await call(
      { mode: "ingest", doc_code: "SALARIOS-V001", ...fields, markdown: body },
      outsider,
    );
    const move = await call(
      { mode: "reclassify", doc_code: "SALARIOS-V001", area: "general" },
      outsider,
    );
    await call({ mode: "ingest", doc_code: "AVISOS-V001", ...fields, markdown: body });
    await drainQueue();
    const moveInto = await call(
      { mode: "reclassify", doc_code: "AVISOS-V001", area: "rrhh" },
      outsider,
    );
    const described = await call({ mode: "validate", doc_code: "SALARIOS-V002" }, outsider);
    const seen = await call({ mode: "validate", doc_code: "SALARIOS-V002" });
    const followed = await call({ mode: "status", job_id: created.job_id }, outsider);
    const stored = parseDocument(await storage.readMarkdown("SALARIOS-V001"));

    // Performs assertions.
    expect(publish.error).toBe("area_not_readable");
    expect(supersede.error).toBe("area_not_readable");
    expect(overwrite.error).toBe("area_not_readable");
    expect(stored.frontmatter.area).toBe("rrhh");
    expect(move.error).toBe("document_not_found");
    expect(moveInto.error).toBe("area_not_readable");
    expect(described.current_version).toBeNull();
    expect(seen.current_version).toMatchObject({ doc_code: "SALARIOS-V001" });
    expect(followed.error).toBe("job_not_found");
  });

  it("refuses an unknown area, missing fields, a bad part and an older version", async () => {
    // Performs the test.
    await call({ mode: "ingest", doc_code: "POLITICA-V002", ...fields, markdown: body });
    await drainQueue();
    const unknownArea = await call({
      mode: "ingest",
      doc_code: "X-V001",
      ...fields,
      area: "ventas",
      markdown: body,
    });
    const missing = await call({ mode: "ingest", doc_code: "X-V001" });
    const badPart = await call({
      mode: "ingest",
      doc_code: "X-V001",
      ...fields,
      markdown: body,
      part: 3,
      parts: 2,
    });
    const older = await call({
      mode: "ingest",
      doc_code: "POLITICA-V001",
      ...fields,
      markdown: body,
    });

    // Performs assertions.
    expect(unknownArea.error).toBe("unknown_area");
    expect(missing.error).toBe("missing_fields");
    expect(badPart.error).toBe("invalid_part");
    expect(older.error).toBe("older_version");
  });

  it("moves a document to another area, its PDF included, without sending it again", async () => {
    // Performs the test.
    const code = "REGLAMENTO-V001";
    await call({ mode: "ingest", doc_code: code, ...fields, markdown: body });
    await drainQueue();
    await storage.save(code, "pdf", Buffer.from("%PDF-1.4 reglamento"), "docs.general.read");
    const moved = await call({
      mode: "reclassify",
      doc_code: code,
      area: "rrhh",
      tags: ["personal"],
    });
    await drainQueue();
    const stored = parseDocument(await storage.readMarkdown(code));
    const pdf = await storage.open(code, "pdf");
    pdf?.stream.destroy();
    const unknown = await call({ mode: "reclassify", doc_code: "NO-EXISTE-V001", area: "rrhh" });
    const nothing = await call({ mode: "reclassify", doc_code: code });

    // Performs assertions.
    expect(moved).toMatchObject({
      result: "queued",
      changes: { area: "rrhh", tags: ["personal"] },
    });
    expect(stored.frontmatter).toMatchObject({
      area: "rrhh",
      tags: ["personal"],
      doc_title: "Guía de bodega",
    });
    expect(stored.body).toBe(body);
    expect(pdf?.requiredScope).toBe("docs.rrhh.read");
    expect(unknown.error).toBe("document_not_found");
    expect(nothing.error).toBe("missing_fields");
    const events = await database.db.select().from(auditLogs);
    expect(events.some((event) => event.eventCode === "docs.reclassified")).toBe(true);
  });
});

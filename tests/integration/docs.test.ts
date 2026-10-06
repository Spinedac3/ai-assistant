import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { PDFDocument } from "pdf-lib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { generateToken, hashToken } from "../../src/auth/opaqueTokens.js";
import { hashPassword } from "../../src/auth/password.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { accessTokens, roleScopes, roles, scopes, users } from "../../src/db/schema.js";
import { PdfConverter } from "../../src/rag/convert.js";
import { Embedder } from "../../src/rag/embeddings.js";
import type { Index } from "../../src/rag/ingest.js";
import { claimNext, runJob } from "../../src/rag/jobs.js";
import { Solr } from "../../src/rag/solr.js";
import { DocumentStorage } from "../../src/rag/storage.js";
import { calculateTool } from "../../src/tools/native/calculate.js";
import { fetchTool, searchTool } from "../../src/tools/native/documents.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { type FakeEmbed, startFakeEmbed } from "../support/fakeEmbed.js";
import { testSigner } from "../support/keys.js";
import { createCores, dropCores } from "../support/solrCores.js";
import { freshDatabase } from "./support/database.js";

const SOLR_URL = process.env.SOLR_URL ?? "http://localhost:8983";
const PASSWORD = "tres caballos verdes";
const silent = { info: () => {}, error: () => {} } as unknown as Parameters<
  typeof runJob
>[0]["logger"];

let database: DatabaseHandle;
let app: FastifyInstance;
let embed: FakeEmbed;
let index: Index;
let storage: DocumentStorage;
let converter: PdfConverter;
// What the fake model writes for each part of a PDF, and how many parts it was asked for
let pageAnswer: (from: number, to: number) => string;
const parts: Array<{ from: number; to: number; pages: number }> = [];

/**
 * Builds a PDF with some empty pages
 *
 * @param   pages  How many
 *
 * @return  The file
 */
async function pdfWith(pages: number): Promise<Buffer> {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page++) {
    document.addPage([200, 200]);
  }

  return Buffer.from(await document.save());
}

/**
 * Uploads a PDF alone, for conversion
 *
 * @param   token  Session
 * @param   pdf    File
 * @param   name   Its name
 *
 * @return  The response
 */
async function convert(token: string, pdf: Buffer, name = "Manual de bodega.pdf") {
  const form = new FormData();
  form.append("original", new Blob([pdf]), name);

  return app.inject({
    method: "POST",
    url: "/docs/conversions",
    headers: { authorization: `Bearer ${token}` },
    payload: form,
  });
}
let adminToken: string;
let userToken: string;
let userId: number;

/**
 * Builds a markdown document
 *
 * @param   code  Document code
 * @param   area  Area
 *
 * @return  The file contents
 */
function markdown(code: string, area = "general"): string {
  return `---\ndoc_code: ${code}\ndoc_title: Manual de bodega ${code}\ndoc_version: V001\narea: ${area}\n---\n# Bodega\n\n## Montacargas\n\nLa velocidad máxima del montacargas dentro de la bodega es de ocho kilómetros por hora.\n`;
}

/**
 * Uploads files as a browser form would
 *
 * @param   token  Bearer token
 * @param   files  Field name to file contents
 *
 * @return  The response
 */
async function upload(token: string, files: Record<string, string | Buffer>) {
  const form = new FormData();
  for (const [field, contents] of Object.entries(files)) {
    form.append(field, new Blob([contents]), field === "original" ? "original.pdf" : "doc.md");
  }
  const encoded = new Response(form);

  return app.inject({
    method: "POST",
    url: "/docs",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": encoded.headers.get("content-type") ?? "",
    },
    payload: Buffer.from(await encoded.arrayBuffer()),
  });
}

/**
 * Indexes every queued document, as the worker would
 */
async function drainQueue(): Promise<void> {
  for (let job = await claimNext(database.db); job; job = await claimNext(database.db)) {
    await runJob({ db: database.db, storage, index, logger: silent }, job);
  }
}

/**
 * Logs in with a password
 *
 * @param   email  Login email
 *
 * @return  The token
 */
async function login(email: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/auth/login",
    payload: { email, password: PASSWORD },
  });

  return response.json().data.token;
}

/**
 * Sends one JSON-RPC request to /mcp as an external client of the user
 *
 * @param   method  JSON-RPC method
 * @param   params  Parameters
 *
 * @return  The JSON-RPC result
 */
async function mcp(method: string, params: object = {}) {
  const token = generateToken("ast");
  await database.db.insert(accessTokens).values({
    userId,
    clientId: "mcp_test",
    accessTokenHash: hashToken(token),
    kind: "oauth",
    accessExpiresAt: sql`now() + interval '1 hour'`,
  });
  const response = await app.inject({
    method: "POST",
    url: "/mcp",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
    },
    payload: { jsonrpc: "2.0", id: 1, method, params },
  });

  return response.json().result;
}

describe("docs", () => {
  beforeAll(async () => {
    embed = await startFakeEmbed();
    database = await freshDatabase();
    index = {
      solr: new Solr(SOLR_URL),
      embedder: new Embedder(embed.url),
      cores: await createCores(SOLR_URL, "routes"),
    };
    storage = new DocumentStorage({
      endpoint: process.env.S3_ENDPOINT ?? "http://localhost:9000",
      accessKey: process.env.S3_ACCESS_KEY ?? "assistant",
      secretKey: process.env.S3_SECRET_KEY ?? "assistant-secret",
      bucket: "documents-test",
    });
    await storage.ensureBucket();
    pageAnswer = (from, to) =>
      Array.from(
        { length: to - from + 1 },
        (_, offset) =>
          `<!-- page: ${from + offset} -->\n## Montacargas ${from + offset}\n\nLa velocidad máxima es de ocho kilómetros por hora.`,
      ).join("\n\n");
    converter = new PdfConverter({
      db: database.db,
      storage,
      convert: async (prompt, pdf) => {
        const [, from, to] = prompt.match(/páginas (\d+) a (\d+)/) ?? [];
        const pages = (await PDFDocument.load(pdf)).getPageCount();
        parts.push({ from: Number(from), to: Number(to), pages });
        return pageAnswer(Number(from), Number(to));
      },
      ask: async () =>
        '{"doc_code": "BOD-PDF-V001", "doc_title": "Manual de bodega", "doc_version": "V001", "area": "general", "tags": ["bodega"]}',
    });
    // A second area, held by the admin role only
    const [hr] = await database.db
      .insert(scopes)
      .values({ code: "docs.rrhh.read", description: "Leer documentos de RRHH" })
      .returning({ id: scopes.id });
    const [adminRole] = await database.db.select().from(roles).where(eq(roles.code, "admin"));
    await database.db
      .insert(roleScopes)
      .values({ roleId: adminRole?.id ?? 0, scopeId: hr?.id ?? 0 });

    for (const [email, role] of [
      ["admin@example.com", "admin"],
      ["ana@example.com", "user"],
    ] as const) {
      const [roleRow] = await database.db.select().from(roles).where(eq(roles.code, role));
      await database.db.insert(users).values({
        email,
        displayName: email,
        passwordHash: await hashPassword(PASSWORD),
        primaryRoleId: roleRow?.id ?? null,
      });
    }

    const registry = new ToolRegistry(database.db);
    registry.register(calculateTool);
    registry.register(searchTool(index));
    registry.register(fetchTool(index));
    app = await buildApp({
      db: database.db,
      signer: testSigner(),
      systems: new Map(),
      docs: { index, storage, converter },
      mcp: {
        registry,
        publicBaseUrl: "https://assistant.example.com",
        settings: {
          assistantName: "Lumen",
          organizationContext: null,
          timeZone: "UTC",
          accessContact: async () => "rrhh@example.com",
        },
      },
    });

    adminToken = await login("admin@example.com");
    userToken = await login("ana@example.com");
    const [ana] = await database.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "ana@example.com"));
    userId = ana?.id ?? 0;
  });

  afterAll(async () => {
    await app.close();
    await dropCores(SOLR_URL, index.cores);
    await embed.close();
    await database.close();
  });

  it("lets only docs.manage upload", async () => {
    // Performs the test.
    const response = await upload(userToken, { document: markdown("BOD-V001") });

    // Performs assertions.
    expect(response.statusCode).toBe(403);
  });

  it("refuses an unknown area, a fake PDF and a missing document", async () => {
    // Performs the test.
    const area = await upload(adminToken, { document: markdown("X-V001", "finanzas") });
    const fakePdf = await upload(adminToken, {
      document: markdown("X-V001"),
      original: "<html>no soy un pdf</html>",
    });
    const missing = await upload(adminToken, { original: "%PDF-1.4" });
    const invalid = await upload(adminToken, { document: "sin encabezado" });

    // Performs assertions.
    expect(area.json().error).toBe("unknown_area");
    expect(fakePdf.json().error).toBe("invalid_original");
    expect(missing.json().error).toBe("missing_document");
    expect(invalid.json().error).toBe("invalid_document");
  });

  it("queues an upload, indexes it and reports the job", async () => {
    // Performs the test.
    const uploaded = await upload(adminToken, {
      document: markdown("BOD-V001"),
      original: Buffer.from("%PDF-1.4 contenido"),
    });
    await drainQueue();
    const job = await app.inject({
      url: `/docs/jobs/${uploaded.json().data.job_id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // Performs assertions.
    expect(uploaded.statusCode).toBe(202);
    expect(job.json().data).toMatchObject({ status: "done", docCode: "BOD-V001" });
    expect(job.json().data.chunks).toBeGreaterThan(0);
  });

  it("lists and serves only the documents the person can read", async () => {
    // Performs the test.
    await upload(adminToken, { document: markdown("RH-V001", "rrhh") });
    await drainQueue();
    const headers = { authorization: `Bearer ${userToken}` };
    const listed = await app.inject({ url: "/docs", headers });
    const original = await app.inject({ url: "/docs/BOD-V001/original?kind=pdf", headers });
    const hidden = await app.inject({ url: "/docs/RH-V001/original", headers });
    const missing = await app.inject({ url: "/docs/NADA-V001/original", headers });

    // Performs assertions.
    expect(listed.json().data.map((doc: { doc_code: string }) => doc.doc_code)).toEqual([
      "BOD-V001",
    ]);
    expect(original.statusCode).toBe(200);
    expect(original.headers["content-type"]).toBe("application/pdf");
    expect(original.headers["content-disposition"]).toBe('attachment; filename="BOD-V001.pdf"');
    expect(original.body).toContain("%PDF");
    expect(hidden.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
  });

  it("offers search and fetch directly to external clients, as ChatGPT requires", async () => {
    // Performs the test.
    const listed = await mcp("tools/list");
    const tools = listed.tools as Array<{ name: string; inputSchema: { properties: object } }>;
    const found = await mcp("tools/call", {
      name: "find_capability",
      arguments: { query: "buscar documentos de bodega" },
    });
    const searched = await mcp("tools/call", {
      name: "search",
      arguments: { query: "velocidad máxima del montacargas" },
    });
    const results = JSON.parse(searched.content[0].text).results as Array<{ id: string }>;
    const fetched = await mcp("tools/call", { name: "fetch", arguments: { id: results[0]?.id } });

    // Performs assertions.
    expect(tools.map((tool) => tool.name)).toEqual([
      "find_capability",
      "run_capability",
      "search",
      "fetch",
    ]);
    expect(tools.find((tool) => tool.name === "search")?.inputSchema.properties).not.toHaveProperty(
      "original_question",
    );
    expect(
      tools.find((tool) => tool.name === "find_capability")?.inputSchema.properties,
    ).toHaveProperty("original_question");
    expect(
      JSON.parse(found.content[0].text).capabilities.map((hit: { name: string }) => hit.name),
    ).not.toContain("search");
    expect(results[0]?.id).toBe("BOD-V001__0");
    expect(JSON.parse(fetched.content[0].text).text).toContain("ocho kilómetros por hora");
  });

  it("refuses an unexpected or repeated file and a markdown over 2 MB", async () => {
    // Performs the test.
    const unexpected = await upload(adminToken, { document: markdown("X-V001"), extra: "x" });
    const valid = await upload(adminToken, {
      document: markdown("X-V001"),
      original: Buffer.from("%PDF-1.4"),
    });
    const form = new FormData();
    form.append("document", new Blob([markdown("X-V001")]), "a.md");
    form.append("document", new Blob([markdown("X-V001")]), "b.md");
    const encoded = new Response(form);
    const twice = await app.inject({
      method: "POST",
      url: "/docs",
      headers: {
        authorization: `Bearer ${adminToken}`,
        "content-type": encoded.headers.get("content-type") ?? "",
      },
      payload: Buffer.from(await encoded.arrayBuffer()),
    });
    const large = await upload(adminToken, {
      document: `${markdown("X-V001")}${"relleno ".repeat(300_000)}`,
    });

    // Performs assertions.
    expect(unexpected.json().error).toBe("unexpected_file");
    expect(valid.statusCode).toBe(202);
    expect(twice.json().error).toBe("unexpected_file");
    expect(large.statusCode).toBe(413);
    await drainQueue();
  });

  it("keeps the connection usable after refusing a markdown over 2 MB", async () => {
    // Performs the test.
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    const send = async (contents: string) => {
      const form = new FormData();
      form.append("document", new Blob([contents]), "doc.md");

      return fetch(`${address}/docs`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminToken}` },
        body: form,
        signal: AbortSignal.timeout(5_000),
      });
    };
    const large = await send(`${markdown("BIG-V001")}${"relleno ".repeat(600_000)}`);
    const statuses = [large.status];
    for (const code of ["NEXT-V001", "LAST-V001"]) {
      statuses.push((await send(markdown(code))).status);
    }
    await drainQueue();

    // Performs assertions.
    expect(statuses).toEqual([413, 202, 202]);
  });

  it("does not bring back a document deleted while it was being indexed", async () => {
    // Performs the test.
    await upload(adminToken, { document: markdown("GONE-V001") });
    const job = await claimNext(database.db);
    // The delete arrives right after the worker read the markdown
    const deleting = Object.create(storage) as DocumentStorage;
    deleting.readMarkdown = async (code: string) => {
      const text = await storage.readMarkdown(code);
      await storage.remove(code);
      return text;
    };
    if (job) {
      await runJob({ db: database.db, storage: deleting, index, logger: silent }, job);
    }
    const found = await app.inject({
      url: "/docs",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // Performs assertions.
    expect(found.json().data.map((doc: { doc_code: string }) => doc.doc_code)).not.toContain(
      "GONE-V001",
    );
  });

  it("refuses to roll a document back to an older version", async () => {
    // Performs the test.
    await upload(adminToken, { document: markdown("FAM-V002") });
    await drainQueue();
    const older = await upload(adminToken, { document: markdown("FAM-V001") });
    const headers = { authorization: `Bearer ${adminToken}` };
    await upload(adminToken, { document: markdown("FAM-V003") });
    await drainQueue();
    const superseded = await app.inject({ method: "POST", url: "/docs/FAM-V002/reindex", headers });
    const deleteSuperseded = await app.inject({ method: "DELETE", url: "/docs/FAM-V002", headers });

    // Performs assertions.
    expect(older.statusCode).toBe(409);
    expect(older.json().message).toContain("FAM-V002");
    expect(superseded.statusCode).toBe(404);
    expect(deleteSuperseded.statusCode).toBe(404);
  });

  it("serves an original only to whoever reads the area it was saved under", async () => {
    // Performs the test.
    const headers = { authorization: `Bearer ${userToken}` };
    await upload(adminToken, {
      document: markdown("MOVE-V001"),
      original: Buffer.from("%PDF-1.4 general"),
    });
    await drainQueue();
    const before = await app.inject({ url: "/docs/MOVE-V001/original", headers });
    // Re-uploaded under a restricted area and not yet indexed: the index still says general
    await upload(adminToken, { document: markdown("MOVE-V001", "rrhh") });
    const pending = await app.inject({ url: "/docs/MOVE-V001/original", headers });
    const oldPdf = await storage.exists("MOVE-V001", "pdf");
    await drainQueue();

    // Performs assertions.
    expect(before.statusCode).toBe(200);
    expect(pending.statusCode).toBe(404);
    expect(oldPdf).toBe(false);
  });

  it("keeps the untrusted-data wrapper when search runs through run_capability", async () => {
    // Performs the test.
    const result = await mcp("tools/call", {
      name: "run_capability",
      arguments: { capability: "search", parameters: { query: "montacargas" } },
    });

    // Performs assertions.
    expect(result.content[0].text.startsWith('<tool_result name="search" trusted="false">')).toBe(
      true,
    );
  });

  it("reindexes from the stored markdown and deletes from search and storage", async () => {
    // Performs the test.
    const headers = { authorization: `Bearer ${adminToken}` };
    const reindex = await app.inject({ method: "POST", url: "/docs/BOD-V001/reindex", headers });
    await drainQueue();
    const unknown = await app.inject({ method: "POST", url: "/docs/NADA-V001/reindex", headers });
    const deleted = await app.inject({ method: "DELETE", url: "/docs/BOD-V001", headers });
    const listed = await app.inject({ url: "/docs", headers });

    // Performs assertions.
    expect(reindex.statusCode).toBe(202);
    expect(unknown.statusCode).toBe(404);
    expect(deleted.statusCode).toBe(200);
    const codes = listed.json().data.map((doc: { doc_code: string }) => doc.doc_code);
    expect(codes).not.toContain("BOD-V001");
    expect(codes).toContain("RH-V001");
    expect(await storage.exists("BOD-V001", "md")).toBe(false);
  });

  it("turns a PDF into a document in parts of ten pages, with a header to review", async () => {
    // Performs the test.
    parts.length = 0;
    const started = await convert(adminToken, await pdfWith(23));
    await converter.idle();
    const id = started.json().data.id;
    const found = await app.inject({
      url: `/docs/conversions/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const data = found.json().data;

    // Performs assertions.
    expect(started.statusCode).toBe(202);
    expect(parts).toEqual([
      { from: 1, to: 10, pages: 10 },
      { from: 11, to: 20, pages: 10 },
      { from: 21, to: 23, pages: 3 },
    ]);
    expect(data).toMatchObject({ status: "done", pages_done: 23, pages_total: 23 });
    expect(data.markdown).toContain("<!-- page: 23 -->");
    expect(data.suggested).toMatchObject({ doc_code: "BOD-PDF-V001", area: "general" });
  });

  it("publishes a reviewed conversion with the PDF as its original, and forgets the conversion", async () => {
    // Performs the test.
    const pdf = await pdfWith(2);
    const id = (await convert(adminToken, pdf)).json().data.id;
    await converter.idle();
    const published = await app.inject({
      method: "POST",
      url: `/docs/conversions/${id}/publish`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        header: {
          doc_code: "BOD-PDF-V001",
          doc_title: "Manual de bodega",
          doc_version: "V001",
          area: "general",
          tags: ["bodega"],
        },
      },
    });
    await drainQueue();
    const original = await app.inject({
      url: "/docs/BOD-PDF-V001/original?kind=pdf",
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const gone = await app.inject({
      url: `/docs/conversions/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    await app.inject({
      method: "DELETE",
      url: "/docs/BOD-PDF-V001",
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // Performs assertions.
    expect(published.statusCode).toBe(202);
    expect(original.statusCode).toBe(200);
    expect(original.rawPayload.equals(pdf)).toBe(true);
    expect(gone.statusCode).toBe(404);
  });

  it("refuses what is not a PDF, one that does not open and one too long to review", async () => {
    // Performs the test.
    const text = await convert(adminToken, Buffer.from("no soy un pdf"));
    const broken = await convert(adminToken, Buffer.from("%PDF-1.7 roto"));
    const long = await convert(adminToken, await pdfWith(301));
    const notManager = await convert(userToken, await pdfWith(1));

    // Performs assertions.
    expect(text.json().error).toBe("invalid_original");
    expect(broken.json().error).toBe("unreadable_pdf");
    expect(long.json().error).toBe("too_many_pages");
    expect(notManager.statusCode).toBe(403);
  });

  it("fails a conversion whose pages the model could not read, and never keeps its excuse", async () => {
    // Performs the test.
    pageAnswer = () => "No pude leer document.pdf: pdftoppm is not installed.";
    const id = (await convert(adminToken, await pdfWith(3))).json().data.id;
    await converter.idle();
    const found = await app.inject({
      url: `/docs/conversions/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    pageAnswer = (from, to) =>
      Array.from(
        { length: to - from + 1 },
        (_, offset) => `<!-- page: ${from + offset} -->\nTexto.`,
      ).join("\n");

    // Performs assertions.
    expect(found.json().data).toMatchObject({ status: "failed", markdown: null });
    expect(found.json().data.error).toContain("No se pudo convertir");
  });

  it("marks as failed the conversions a stopped server left unfinished", async () => {
    // Performs the test.
    const id = (await convert(adminToken, await pdfWith(1))).json().data.id;
    await converter.idle();
    await database.db.execute(sql`update pdf_conversions set status = 'running' where id = ${id}`);
    await converter.recover();
    const found = await app.inject({
      url: `/docs/conversions/${id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // Performs assertions.
    expect(found.json().data.status).toBe("failed");
  });

  describe("pdf conversions under strain", () => {
    /**
     * Reads a conversion as its owner
     *
     * @param   id  Conversion id
     *
     * @return  The response
     */
    const seen = (id: string) =>
      app.inject({
        url: `/docs/conversions/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });

    /**
     * Publishes a conversion with a header
     *
     * @param   id      Conversion id
     * @param   header  Header fields
     *
     * @return  The response
     */
    const publish = (id: string, header: Record<string, unknown>) =>
      app.inject({
        method: "POST",
        url: `/docs/conversions/${id}/publish`,
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { header },
      });

    const header = {
      doc_code: "BOD-CARGA-V001",
      doc_title: "Carga de camiones",
      doc_version: "V001",
      area: "general",
    };

    it("leaves no conversion waiting when its file could not be kept", async () => {
      // Performs the test.
      const failing = new PdfConverter({
        db: database.db,
        storage: {
          saveConversion: async () => {
            throw new Error("sin espacio");
          },
        } as unknown as DocumentStorage,
        convert: async () => "",
        ask: async () => "{}",
      });
      const attempt = await failing
        .start(userId, "a.pdf", await pdfWith(1), 1, ["general"])
        .catch((error: Error) => error.message);
      const left = await database.db.execute(
        sql`select count(*)::int as n from pdf_conversions where file_name = 'a.pdf'`,
      );

      // Performs assertions.
      expect(attempt).toBe("sin espacio");
      expect((left.rows[0] as { n: number }).n).toBe(0);
    });

    it("goes on with the next conversion after one fails", async () => {
      // Performs the test.
      let calls = 0;
      const answer = pageAnswer;
      pageAnswer = (from, to) => {
        calls += 1;
        if (calls === 1) {
          throw new Error("el modelo se cayó");
        }
        return answer(from, to);
      };
      const failed = (await convert(adminToken, await pdfWith(1))).json().data.id;
      const next = (await convert(adminToken, await pdfWith(1))).json().data.id;
      await converter.idle();
      pageAnswer = answer;

      // Performs assertions.
      expect((await seen(failed)).json().data.status).toBe("failed");
      expect((await seen(next)).json().data.status).toBe("done");
    });

    it("publishes once, gives a refused header back to correct, and waits for a running one", async () => {
      // Performs the test.
      const id = (await convert(adminToken, await pdfWith(1))).json().data.id;
      await converter.idle();
      const refused = await publish(id, { ...header, area: "inexistente" });
      const afterRefused = (await seen(id)).json().data.status;
      const empty = await publish(id, { ...header, doc_version: " " });
      const [first, second] = await Promise.all([publish(id, header), publish(id, header)]);
      await drainQueue();
      const running = (await convert(adminToken, await pdfWith(1))).json().data.id;
      await database.db.execute(
        sql`update pdf_conversions set status = 'running' where id = ${running}`,
      );
      const early = await publish(running, header);
      await database.db.execute(
        sql`update pdf_conversions set status = 'done' where id = ${running}`,
      );
      await app.inject({
        method: "DELETE",
        url: "/docs/BOD-CARGA-V001",
        headers: { authorization: `Bearer ${adminToken}` },
      });

      // Performs assertions.
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect(afterRefused).toBe("done");
      expect(empty.json().message).toBe("Falta la versión");
      expect([first.statusCode, second.statusCode].sort()).toEqual([202, 409]);
      expect(early.statusCode).toBe(409);
    });

    it("shows no one else's conversion, and discarding one removes its file", async () => {
      // Performs the test.
      const id = (await convert(adminToken, await pdfWith(1))).json().data.id;
      await converter.idle();
      await database.db.execute(
        sql`update pdf_conversions set user_id = ${userId} where id = ${id}`,
      );
      const foreign = await seen(id);
      const foreignDelete = await app.inject({
        method: "DELETE",
        url: `/docs/conversions/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const [admin] = await database.db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.email, "admin@example.com"));
      await database.db.execute(
        sql`update pdf_conversions set user_id = ${admin?.id ?? 0} where id = ${id}`,
      );
      const discarded = await app.inject({
        method: "DELETE",
        url: `/docs/conversions/${id}`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      const file = await storage
        .readConversion(id)
        .then(() => "still there")
        .catch(() => "gone");

      // Performs assertions.
      expect(foreign.statusCode).toBe(404);
      expect(foreignDelete.statusCode).toBe(404);
      expect(discarded.statusCode).toBe(200);
      expect(file).toBe("gone");
    });

    it("keeps two PDFs converting per person, and one discarded halfway stops", async () => {
      // Performs the test.
      parts.length = 0;
      let release: () => void = () => undefined;
      const answer = pageAnswer;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      pageAnswer = (from, to) => answer(from, to);
      const slow = new PdfConverter({
        db: database.db,
        storage,
        convert: async (prompt) => {
          const [, from, to] = prompt.match(/páginas (\d+) a (\d+)/) ?? [];
          parts.push({ from: Number(from), to: Number(to), pages: 0 });
          await held;
          return answer(Number(from), Number(to));
        },
        ask: async () => "{}",
      });
      const first = await slow.start(userId, "uno.pdf", await pdfWith(25), 25, ["general"]);
      await slow.start(userId, "dos.pdf", await pdfWith(1), 1, ["general"]);
      const pending = await slow.pending(userId);
      await slow.remove(first);
      release();
      await slow.idle();
      const leftovers = await slow.list(userId);
      for (const row of leftovers) {
        await slow.remove(row.id);
      }

      // Performs assertions.
      expect(pending).toBe(2);
      // The first part was already being written; nothing after it was asked for
      expect(parts.filter((part) => part.to > 10 && part.to <= 25)).toEqual([]);
    });

    it("removes old reviewed conversions with their files, and keeps the rest", async () => {
      // Performs the test.
      const old = (await convert(adminToken, await pdfWith(1))).json().data.id;
      const fresh = (await convert(adminToken, await pdfWith(1))).json().data.id;
      await converter.idle();
      await database.db.execute(
        sql`update pdf_conversions set created_at = now() - interval '8 days' where id = ${old}`,
      );
      const purged = await converter.purge(new Date(Date.now() - 7 * 86_400_000));

      // Performs assertions.
      expect(purged).toBe(1);
      expect((await seen(old)).statusCode).toBe(404);
      expect((await seen(fresh)).statusCode).toBe(200);
    });
  });
});

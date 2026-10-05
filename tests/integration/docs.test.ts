import { eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app.js";
import { generateToken, hashToken } from "../../src/auth/opaqueTokens.js";
import { hashPassword } from "../../src/auth/password.js";
import type { DatabaseHandle } from "../../src/db/client.js";
import { accessTokens, roleScopes, roles, scopes, users } from "../../src/db/schema.js";
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
      docs: { index, storage },
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
    expect(listed.json().data.map((doc: { doc_code: string }) => doc.doc_code)).toEqual([
      "RH-V001",
    ]);
    expect(await storage.exists("BOD-V001", "md")).toBe(false);
  });
});

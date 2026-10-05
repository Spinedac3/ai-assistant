import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "../../src/db/client.js";
import { documentJobs } from "../../src/db/schema.js";
import { parseDocument } from "../../src/rag/document.js";
import { Embedder } from "../../src/rag/embeddings.js";
import { type Index, ingestDocument, removeDocument } from "../../src/rag/ingest.js";
import { claimNext, enqueue, failInterrupted, findJob } from "../../src/rag/jobs.js";
import { fetchPassage, searchDocuments } from "../../src/rag/search.js";
import { escapeTerm, Solr } from "../../src/rag/solr.js";
import { type FakeEmbed, startFakeEmbed } from "../support/fakeEmbed.js";
import { createCores, dropCores } from "../support/solrCores.js";
import { freshDatabase } from "./support/database.js";

const SOLR_URL = process.env.SOLR_URL ?? "http://localhost:8983";
const GENERAL = new Set(["docs.general.read"]);

let embed: FakeEmbed;
let index: Index;
let database: DatabaseHandle;

/**
 * Writes a demo document with the given code, area and body
 *
 * @param   code  Document code
 * @param   area  Area
 * @param   body  Markdown body
 *
 * @return  The whole file
 */
function document(code: string, area: string, body: string): string {
  return `---\ndoc_code: ${code}\ndoc_title: Política de devoluciones\ndoc_version: ${code.slice(-4)}\narea: ${area}\n---\n${body}`;
}

const RETURNS_V1 = document(
  "DEV-V001",
  "general",
  "# Devoluciones\n\n## Plazo\n\nEl cliente puede devolver un producto dentro de los 15 días siguientes a la entrega con su nota de envío.\n",
);
const RETURNS_V2 = document(
  "DEV-V002",
  "general",
  "# Devoluciones\n\n## Plazo\n\nEl cliente puede devolver un producto dentro de los 30 días siguientes a la entrega con su nota de envío.\n\n## Reembolso\n\nLa devolución se acredita como nota de crédito para el siguiente pedido del cliente, nunca en efectivo.\n",
);
const TRAVEL = document(
  "VIAT-V001",
  "rrhh",
  "# Viáticos\n\n## Montos\n\nEl hospedaje se paga hasta seiscientos quetzales por noche de viaje de trabajo autorizado.\n",
);

describe("rag", () => {
  beforeAll(async () => {
    embed = await startFakeEmbed();
    database = await freshDatabase();
    index = {
      solr: new Solr(SOLR_URL),
      embedder: new Embedder(embed.url),
      cores: await createCores(SOLR_URL, "test"),
    };
  });

  afterAll(async () => {
    await dropCores(SOLR_URL, index.cores);
    await embed.close();
    await database.close();
  });

  it("moves the previous version of a family to the history", async () => {
    // Performs the test.
    await ingestDocument(index, parseDocument(RETURNS_V1));
    const result = await ingestDocument(index, parseDocument(RETURNS_V2));
    const current = await index.solr.query<{ doc_code: string }>(index.cores.current, {
      query: "doc_family:DEV",
      limit: 50,
    });
    const history = await index.solr.query<{ doc_code: string; is_current: boolean }>(
      index.cores.historical,
      { query: "doc_family:DEV", limit: 50 },
    );

    // Performs assertions.
    expect(result.superseded).toEqual(["DEV-V001"]);
    expect(new Set(current.map((chunk) => chunk.doc_code))).toEqual(new Set(["DEV-V002"]));
    expect(history.length).toBeGreaterThan(0);
    expect(history.every((chunk) => chunk.doc_code === "DEV-V001" && !chunk.is_current)).toBe(true);
  });

  it("leaves no leftovers when a document comes back shorter", async () => {
    // Performs the test.
    const long = document(
      "LARGO-V001",
      "general",
      Array.from(
        { length: 6 },
        (_, n) => `## Parte ${n}\n\n${"Texto de relleno con contenido. ".repeat(4)}\n`,
      ).join("\n"),
    );
    const short = document(
      "LARGO-V001",
      "general",
      `## Parte 0\n\n${"Texto breve que queda. ".repeat(4)}\n`,
    );
    await ingestDocument(index, parseDocument(long));
    await ingestDocument(index, parseDocument(short));
    const chunks = await index.solr.query(index.cores.current, {
      query: `doc_code:${escapeTerm("LARGO-V001")}`,
      limit: 50,
    });

    // Performs assertions.
    expect(chunks).toHaveLength(1);
  });

  it("keeps the indexed version when the embedding service fails", async () => {
    // Performs the test.
    const broken: Index = { ...index, embedder: new Embedder("http://127.0.0.1:9") };
    const attempt = ingestDocument(broken, parseDocument(RETURNS_V2.replace("30 días", "45 días")));
    await expect(attempt).rejects.toThrow();
    const { results } = await searchDocuments(index, GENERAL, "DEV-V002");

    // Performs assertions.
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((result) => result.snippet).join(" ")).toContain("30 días");
  });

  it("filters every result by the areas the person can read", async () => {
    // Performs the test.
    await ingestDocument(index, parseDocument(TRAVEL));
    const general = await searchDocuments(index, GENERAL, "hospedaje viaje de trabajo", 50);
    const both = await searchDocuments(
      index,
      new Set(["docs.general.read", "docs.rrhh.read"]),
      "hospedaje viaje de trabajo",
      50,
    );
    const none = await searchDocuments(index, new Set(["chat.use"]), "hospedaje");
    const fetchedHidden = await fetchPassage(index, GENERAL, "VIAT-V001__0");

    // Performs assertions.
    expect(general.results.some((result) => result.id.startsWith("VIAT"))).toBe(false);
    expect(both.results[0]?.id).toBe("VIAT-V001__0");
    expect(none.status).toBe("no_access");
    expect(fetchedHidden.status).toBe("not_found");
  });

  it("returns a document asked for by its exact code, whatever its case", async () => {
    // Performs the test.
    const { results } = await searchDocuments(index, GENERAL, "dev-v002");

    // Performs assertions.
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.id.startsWith("DEV-V002__"))).toBe(true);
  });

  it("goes on with words only when the embedding service is down", async () => {
    // Performs the test.
    const wordsOnly: Index = { ...index, embedder: new Embedder("http://127.0.0.1:9") };
    const { status, results } = await searchDocuments(
      wordsOnly,
      GENERAL,
      "nota de crédito efectivo",
    );

    // Performs assertions.
    expect(status).toBe("ok");
    expect(results[0]?.id.startsWith("DEV-V002")).toBe(true);
  });

  it("says the search is unavailable instead of returning an empty list when Solr is down", async () => {
    // Performs the test.
    const down: Index = { ...index, solr: new Solr("http://127.0.0.1:9") };
    const searched = await searchDocuments(down, GENERAL, "devoluciones");
    const fetched = await fetchPassage(down, GENERAL, "DEV-V002__0");

    // Performs assertions.
    expect(searched.status).toBe("unavailable");
    expect(fetched.status).toBe("unavailable");
  });

  it("fetches a passage with its whole section", async () => {
    // Performs the test.
    const section = document(
      "SECC-V001",
      "general",
      `# Manual\n\n## Carga\n\n${Array.from({ length: 4 }, (_, n) => `Paso ${n + 1}: ${"instrucción detallada del paso de carga. ".repeat(6)}\n`).join("\n")}`,
    );
    await ingestDocument(index, parseDocument(section));
    const { document: fetched } = await fetchPassage(index, GENERAL, "SECC-V001__1");

    // Performs assertions.
    expect(fetched?.text).toContain("Paso 1:");
    expect(fetched?.text).toContain("Paso 4:");
    expect(fetched?.metadata.pieces).toBeGreaterThan(1);
  });

  it("removes a document from the search", async () => {
    // Performs the test.
    await removeDocument(index, "SECC-V001");
    const { results } = await searchDocuments(index, GENERAL, "SECC-V001");

    // Performs assertions.
    expect(results.some((result) => result.id.startsWith("SECC"))).toBe(false);
  });

  it("hands each queued job to one worker only and fails the ones left running", async () => {
    // Performs the test.
    const first = await enqueue(database.db, "A-V001", "upload", 1);
    const second = await enqueue(database.db, "B-V001", "upload", 1);
    const claims = await Promise.all([claimNext(database.db), claimNext(database.db)]);
    const empty = await claimNext(database.db);
    await failInterrupted(database.db);
    const interrupted = await findJob(database.db, first);
    await database.db.execute(sql`delete from ${documentJobs}`);

    // Performs assertions.
    expect(new Set(claims.map((job) => job?.id))).toEqual(new Set([first, second]));
    expect(empty).toBeNull();
    expect(interrupted?.status).toBe("failed");
  });
});

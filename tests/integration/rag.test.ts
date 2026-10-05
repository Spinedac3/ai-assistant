import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { DatabaseHandle } from "../../src/db/client.js";
import { documentJobs } from "../../src/db/schema.js";
import { parseDocument } from "../../src/rag/document.js";
import { Embedder } from "../../src/rag/embeddings.js";
import { type Index, ingestDocument, isCurrent, removeDocument } from "../../src/rag/ingest.js";
import { claimNext, enqueue, failInterrupted, findJob, startWorker } from "../../src/rag/jobs.js";
import { fetchPassage, searchDocuments } from "../../src/rag/search.js";
import { escapeTerm, Solr, type SolrQuery } from "../../src/rag/solr.js";
import type { DocumentStorage } from "../../src/rag/storage.js";
import { type FakeEmbed, startFakeEmbed } from "../support/fakeEmbed.js";
import { createCores, dropCores } from "../support/solrCores.js";
import { freshDatabase } from "./support/database.js";

const SOLR_URL = process.env.SOLR_URL ?? "http://localhost:8983";
const GENERAL = new Set(["docs.general.read"]);
const silent = { info: () => {}, error: () => {} } as never;

let embed: FakeEmbed;
let index: Index;
let database: DatabaseHandle;

/**
 * Writes a document with the given code, area and body
 *
 * @param   code  Document code
 * @param   area  Area
 * @param   body  Markdown body
 *
 * @return  The parsed document
 */
function document(code: string, area: string, body: string) {
  return parseDocument(
    `---\ndoc_code: ${code}\ndoc_title: Política de devoluciones\ndoc_version: ${code.slice(-4)}\narea: ${area}\n---\n${body}`,
  );
}

/**
 * A returns policy whose deadline tells the versions apart
 *
 * @param   code  Document code
 * @param   days  Deadline in days
 *
 * @return  The parsed document
 */
function returns(code: string, days: number) {
  return document(
    code,
    "general",
    `# Devoluciones\n\n## Plazo\n\nEl cliente puede devolver un producto dentro de los ${days} días siguientes a la entrega con su nota de envío.\n\n## Reembolso\n\nLa devolución se acredita como nota de crédito para el siguiente pedido del cliente, nunca en efectivo.\n`,
  );
}

/**
 * Lists the codes in a core for a family
 *
 * @param   core    Core name
 * @param   family  Family
 *
 * @return  The distinct codes
 */
async function codesIn(core: string, family: string): Promise<Set<string>> {
  const chunks = await index.solr.query<{ doc_code: string }>(core, {
    query: `doc_family:${escapeTerm(family)}`,
    limit: 100,
  });

  return new Set(chunks.map((chunk) => chunk.doc_code));
}

// Fails every add after the first one it lets through
class FlakySolr extends Solr {
  private adds = 0;

  override async add(core: string, documents: Array<Record<string, unknown>>): Promise<void> {
    for (const document of documents) {
      if (this.adds++ >= 1) {
        throw new Error("Solr cayó a mitad");
      }

      await super.add(core, [document]);
    }
  }
}

describe("rag", () => {
  beforeAll(async () => {
    embed = await startFakeEmbed();
    database = await freshDatabase();
    index = {
      solr: new Solr(SOLR_URL),
      embedder: new Embedder(embed.url),
      cores: await createCores(SOLR_URL, "test"),
    };

    await ingestDocument(index, returns("DEV-V002", 30));
    await ingestDocument(
      index,
      document(
        "VIAT-V001",
        "rrhh",
        "# Viáticos\n\n## Montos\n\nEl hospedaje se paga hasta seiscientos quetzales por noche de viaje de trabajo autorizado.\n",
      ),
    );
  });

  afterAll(async () => {
    await dropCores(SOLR_URL, index.cores);
    await embed.close();
    await database.close();
  });

  it("moves the previous version of a family to the history", async () => {
    // Performs the test.
    await ingestDocument(index, returns("MOV-V001", 15));
    const result = await ingestDocument(index, returns("MOV-V002", 30));
    const history = await index.solr.query<{ is_current: boolean }>(index.cores.historical, {
      query: "doc_family:MOV",
      limit: 50,
    });

    // Performs assertions.
    expect(result.superseded).toEqual(["MOV-V001"]);
    expect(await codesIn(index.cores.current, "MOV")).toEqual(new Set(["MOV-V002"]));
    expect(await codesIn(index.cores.historical, "MOV")).toEqual(new Set(["MOV-V001"]));
    expect(history.every((chunk) => chunk.is_current === false)).toBe(true);
  });

  it("refuses a version older than the current one instead of rolling back", async () => {
    // Performs the test.
    await ingestDocument(index, returns("ROLL-V002", 30));
    const older = ingestDocument(index, returns("ROLL-V001", 15));

    // Performs assertions.
    await expect(older).rejects.toThrow("ROLL-V002");
    expect(await codesIn(index.cores.current, "ROLL")).toEqual(new Set(["ROLL-V002"]));
  });

  it("takes a retired version out of the history when it becomes current again", async () => {
    // Performs the test.
    await ingestDocument(index, returns("BACK-V001", 15));
    await ingestDocument(index, returns("BACK-V002", 30));
    await removeDocument(index, "BACK-V002");
    await ingestDocument(index, returns("BACK-V001", 15));

    // Performs assertions.
    expect(await codesIn(index.cores.current, "BACK")).toEqual(new Set(["BACK-V001"]));
    expect(await codesIn(index.cores.historical, "BACK")).toEqual(new Set());
  });

  it("leaves no leftovers when a document comes back shorter", async () => {
    // Performs the test.
    const part = (n: number) =>
      `## Parte ${n}\n\n${"Texto de relleno con contenido. ".repeat(4)}\n`;
    await ingestDocument(
      index,
      document("LARGO-V001", "general", [0, 1, 2, 3, 4, 5].map(part).join("\n")),
    );
    await ingestDocument(index, document("LARGO-V001", "general", part(0)));
    const chunks = await index.solr.query(index.cores.current, {
      query: `doc_code:${escapeTerm("LARGO-V001")}`,
      limit: 50,
    });

    // Performs assertions.
    expect(chunks).toHaveLength(1);
  });

  it("keeps the indexed version when the embedding service fails", async () => {
    // Performs the test.
    await ingestDocument(index, returns("EMB-V001", 30));
    const broken: Index = { ...index, embedder: new Embedder("http://127.0.0.1:9") };
    await expect(ingestDocument(broken, returns("EMB-V001", 45))).rejects.toThrow();
    const { results } = await searchDocuments(index, GENERAL, "EMB-V001");

    // Performs assertions.
    expect(results.map((result) => result.snippet).join(" ")).toContain("30 días");
  });

  it("rolls back a half written document instead of publishing the gap", async () => {
    // Performs the test.
    await ingestDocument(index, returns("HALF-V001", 30));
    const before = await index.solr.query(index.cores.current, {
      query: "doc_code:HALF\\-V001",
      limit: 50,
    });
    const flaky: Index = { ...index, solr: new FlakySolr(SOLR_URL) };
    await expect(ingestDocument(flaky, returns("HALF-V001", 45))).rejects.toThrow("a mitad");
    // Any later commit would publish what was left pending
    await ingestDocument(index, returns("OTHER-V001", 10));
    const after = await index.solr.query<{ text: string }>(index.cores.current, {
      query: "doc_code:HALF\\-V001",
      limit: 50,
    });

    // Performs assertions.
    expect(after).toHaveLength(before.length);
    expect(after.map((chunk) => chunk.text).join(" ")).toContain("30 días");
  });

  it("never publishes half a document when a delete lands in the middle of an ingest", async () => {
    // Performs the test.
    class SlowSolr extends Solr {
      override async add(core: string, documents: Array<Record<string, unknown>>): Promise<void> {
        for (const document of documents) {
          await new Promise((resolve) => setTimeout(resolve, 40));
          await super.add(core, [document]);
        }
      }
    }
    const slow: Index = { ...index, solr: new SlowSolr(SOLR_URL) };
    const steps = [1, 2, 3, 4, 5, 6]
      .map((n) => `## Paso ${n}\n\n${"Texto del paso con instrucciones completas. ".repeat(3)}\n`)
      .join("\n");
    const ingest = ingestDocument(slow, document("RACE-V001", "general", steps));
    await new Promise((resolve) => setTimeout(resolve, 120));
    await Promise.all([ingest, removeDocument(index, "RACE-V001")]);
    const left = await index.solr.query(index.cores.current, {
      query: `doc_code:${escapeTerm("RACE-V001")}`,
      limit: 50,
    });

    // Performs assertions.
    expect(left).toHaveLength(0);
  });

  it("filters every result by the areas the person can read", async () => {
    // Performs the test.
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

  it("reads the words AND, OR and NOT as words, not as operators", async () => {
    // Performs the test.
    const outcomes = await Promise.all(
      ["plazo devolución OR", "AND", "NOT nota de crédito"].map((question) =>
        searchDocuments(index, GENERAL, question),
      ),
    );

    // Performs assertions.
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["ok", "ok", "ok"]);
    expect(outcomes[2]?.results.some((result) => result.id.startsWith("DEV-V002"))).toBe(true);
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

  it("goes on with words only when the vector query fails", async () => {
    // Performs the test.
    class NoVectors extends Solr {
      override query<T>(core: string, query: SolrQuery): Promise<T[]> {
        return query.query.startsWith("{!knn")
          ? Promise.reject(new Error("400"))
          : super.query<T>(core, query);
      }
    }
    const { status, results } = await searchDocuments(
      { ...index, solr: new NoVectors(SOLR_URL) },
      GENERAL,
      "nota de crédito efectivo",
    );

    // Performs assertions.
    expect(status).toBe("ok");
    expect(results.length).toBeGreaterThan(0);
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
    const steps = [1, 2, 3, 4]
      .map((n) => `Paso ${n}: ${"instrucción detallada del paso de carga. ".repeat(6)}\n`)
      .join("\n");
    await ingestDocument(
      index,
      document("SECC-V001", "general", `# Manual\n\n## Carga (A & B)\n\n${steps}`),
    );
    const { document: fetched } = await fetchPassage(index, GENERAL, "SECC-V001__1");

    // Performs assertions.
    expect(fetched?.text).toContain("Paso 1:");
    expect(fetched?.text).toContain("Paso 4:");
    expect(fetched?.metadata.pieces).toBeGreaterThan(1);
  });

  it("retires a document from the search", async () => {
    // Performs the test.
    await ingestDocument(index, returns("RET-V001", 30));
    await removeDocument(index, "RET-V001");
    const { results } = await searchDocuments(index, GENERAL, "RET-V001");

    // Performs assertions.
    expect(await isCurrent(index, "RET-V001")).toBe(false);
    expect(results.some((result) => result.id.startsWith("RET"))).toBe(false);
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

  it("never claims a job once it is stopping, and waits for the job in progress", async () => {
    // Performs the test.
    let release = () => {};
    const storage = {
      readMarkdown: () =>
        new Promise<string>((resolve) => {
          release = () => resolve("sin encabezado");
        }),
    } as unknown as DocumentStorage;
    const running = await enqueue(database.db, "C-V001", "upload", 1);
    const stop = startWorker({ db: database.db, storage, index, logger: silent, pollMs: 60_000 });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const waiting = await enqueue(database.db, "D-V001", "upload", 1);
    const stopped = stop();
    release();
    await stopped;
    const [finished, untouched] = await Promise.all([
      findJob(database.db, running),
      findJob(database.db, waiting),
    ]);
    await database.db.execute(sql`delete from ${documentJobs}`);

    // Performs assertions.
    expect(finished?.status).toBe("failed");
    expect(untouched?.status).toBe("queued");
  });
});

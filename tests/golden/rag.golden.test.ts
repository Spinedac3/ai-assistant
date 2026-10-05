import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadRagEnv } from "../../src/config/env.js";
import { parseDocument } from "../../src/rag/document.js";
import { Embedder } from "../../src/rag/embeddings.js";
import { type Index, ingestDocument } from "../../src/rag/ingest.js";
import { fetchPassage, searchDocuments } from "../../src/rag/search.js";
import { escapeTerm, Solr } from "../../src/rag/solr.js";
import { createCores, dropCores } from "../support/solrCores.js";

const DEMO = "demo/documents";
const GENERAL = new Set(["docs.general.read"]);
const WITH_HR = new Set(["docs.general.read", "docs.rrhh.read"]);

// Each question names the document that answers it; the bar is that document in the first three
const QUESTIONS: Array<{ question: string; expected: string; scopes?: Set<string> }> = [
  {
    question: "¿Cuántos días tiene un cliente para devolver un producto?",
    expected: "VEN-POL-DEV-V002",
  },
  { question: "¿Se puede devolver producto refrigerado?", expected: "VEN-POL-DEV-V002" },
  { question: "¿Quién autoriza una devolución de Q 3,000?", expected: "VEN-POL-DEV-V002" },
  {
    question: "¿A qué temperatura debe llegar un camión refrigerado del proveedor?",
    expected: "BOD-PRO-RECEP-V001",
  },
  { question: "¿En qué horario se reciben los proveedores?", expected: "BOD-PRO-RECEP-V001" },
  {
    question: "¿Qué hago si la factura del proveedor no coincide con lo que llegó?",
    expected: "BOD-PRO-RECEP-V001",
  },
  {
    question: "¿Qué producto se despacha primero, el que vence antes o el que entró antes?",
    expected: "BOD-PRO-ALM-V001",
  },
  {
    question: "¿Qué pasa con un producto al que le quedan 7 días de vida útil?",
    expected: "BOD-PRO-ALM-V001",
  },
  {
    question: "¿Cada cuánto se anota la temperatura de las cámaras?",
    expected: "BOD-PRO-ALM-V001",
  },
  {
    question: "¿A qué hora es el corte de pedidos para entregar al día siguiente?",
    expected: "BOD-PRO-DESP-V001",
  },
  { question: "¿En qué orden se carga el camión?", expected: "BOD-PRO-DESP-V001" },
  { question: "¿Cada cuánto se cuentan los productos clase A?", expected: "BOD-INS-INV-V001" },
  {
    question: "¿Quién aprueba un ajuste de inventario mayor al 1 %?",
    expected: "BOD-INS-INV-V001",
  },
  {
    question: "¿Cuál es el pedido mínimo para entrega a domicilio?",
    expected: "VEN-MAN-VENTAS-V001",
  },
  {
    question: "¿Cuánto descuento puede dar un vendedor sin pedir autorización?",
    expected: "VEN-MAN-VENTAS-V001",
  },
  { question: "¿Qué plazo de crédito tiene un cliente mayorista?", expected: "VEN-POL-CRED-V001" },
  {
    question: "¿Qué pasa si un cliente tiene 15 días de atraso en su pago?",
    expected: "VEN-POL-CRED-V001",
  },
  {
    question: "¿Cuántos clientes puede llevar un camión pequeño en una ruta?",
    expected: "LOG-PRO-RUTAS-V001",
  },
  { question: "¿Cuánto espera el piloto si el cliente no está?", expected: "LOG-PRO-RUTAS-V001" },
  { question: "¿Cada cuántos kilómetros va el camión a servicio?", expected: "LOG-INS-VEH-V001" },
  { question: "¿Puede salir un camión con una luz de freno mala?", expected: "LOG-INS-VEH-V001" },
  {
    question: "¿Cuál es la velocidad máxima del montacargas en la bodega?",
    expected: "SEG-REG-BOD-V001",
  },
  { question: "¿Cuánto peso puede levantar una persona sola?", expected: "SEG-REG-BOD-V001" },
  {
    question: "Un cliente encontró un cuerpo extraño en el producto, ¿qué hacemos?",
    expected: "CAL-PRO-RECL-V001",
  },
  { question: "¿Cuándo se retira un lote del mercado?", expected: "CAL-PRO-RECL-V001" },
  {
    question: "¿Cuántos días de vacaciones me tocan?",
    expected: "RH-REG-INT-V001",
    scopes: WITH_HR,
  },
  { question: "¿Puedo trabajar desde casa?", expected: "RH-REG-INT-V001", scopes: WITH_HR },
  {
    question: "¿Cuánto pagan de hospedaje en un viaje de trabajo?",
    expected: "RH-POL-VIAT-V001",
    scopes: WITH_HR,
  },
  { question: "BOD-PRO-DESP-V001", expected: "BOD-PRO-DESP-V001" },
  { question: "VEN-POL-CRED-V001", expected: "VEN-POL-CRED-V001" },
];

// Measured with bge-m3 on the demo documents; a change that drops below this made search worse
const MIN_TOP3 = 0.9;

let index: Index;

describe("rag golden", () => {
  beforeAll(async () => {
    const env = loadRagEnv();
    index = {
      solr: new Solr(env.SOLR_URL),
      embedder: new Embedder(env.EMBED_URL),
      cores: await createCores(env.SOLR_URL, "golden"),
    };

    for (const name of readdirSync(DEMO).sort()) {
      await ingestDocument(index, parseDocument(readFileSync(join(DEMO, name), "utf8")));
    }
  }, 300_000);

  afterAll(async () => {
    await dropCores(loadRagEnv().SOLR_URL, index.cores);
  });

  it("finds the document that answers each question in the first three", async () => {
    // Performs the test.
    const misses: string[] = [];
    for (const { question, expected, scopes } of QUESTIONS) {
      const { results } = await searchDocuments(index, scopes ?? GENERAL, question, 3);
      if (!results.some((result) => result.id.startsWith(`${expected}__`))) {
        misses.push(`${question} → ${results.map((result) => result.id).join(", ")}`);
      }
    }
    const top3 = 1 - misses.length / QUESTIONS.length;
    // biome-ignore lint/suspicious/noConsole: the measured rate is what this test reports
    console.info(
      `top-3: ${Math.round(top3 * 100)}%${misses.length ? `\n  ${misses.join("\n  ")}` : ""}`,
    );

    // Performs assertions.
    expect(top3).toBeGreaterThanOrEqual(MIN_TOP3);
  });

  it("answers from the current version only", async () => {
    // Performs the test.
    const { results } = await searchDocuments(
      index,
      GENERAL,
      "plazo para devolver un producto",
      10,
    );
    const history = await index.solr.query(index.cores.historical, {
      query: `doc_code:${escapeTerm("VEN-POL-DEV-V001")}`,
      limit: 1,
    });

    // Performs assertions.
    expect(results.some((result) => result.id.startsWith("VEN-POL-DEV-V001"))).toBe(false);
    expect(history).toHaveLength(1);
  });

  it("never shows a document of an area the person cannot read", async () => {
    // Performs the test.
    const searched = await searchDocuments(
      index,
      GENERAL,
      "viáticos de hospedaje y vacaciones",
      50,
    );
    const fetched = await fetchPassage(index, GENERAL, "RH-POL-VIAT-V001__1");

    // Performs assertions.
    expect(searched.results.some((result) => result.id.startsWith("RH-"))).toBe(false);
    expect(fetched.status).toBe("not_found");
  });
});

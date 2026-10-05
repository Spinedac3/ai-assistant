import { describe, expect, it } from "vitest";
import { chunkDocument, docFamily, embeddingText, parseDocument } from "../../src/rag/document.js";

const HEADER =
  "---\ndoc_code: GUIA-V002\ndoc_title: Guía de bodega\ndoc_version: V002\narea: general\ntags: [bodega, 'seguridad']\neffective_date: 2026-03-01\n---\n";

describe("document", () => {
  it("reads the frontmatter and turns the area into its scope", () => {
    // Performs the test.
    const parsed = parseDocument(`${String.fromCodePoint(0xfeff)}${HEADER}# Título\r\n\r\nTexto`);
    const [chunk] = chunkDocument({
      ...parsed,
      body: `# Título\n\n${"Texto del cuerpo. ".repeat(5)}`,
    });

    // Performs assertions.
    expect(parsed.frontmatter).toMatchObject({
      doc_code: "GUIA-V002",
      tags: ["bodega", "seguridad"],
      effective_date: "2026-03-01",
    });
    expect(parsed.body).not.toContain("\r");
    expect(chunk?.required_scope).toBe("docs.general.read");
    expect(chunk?.doc_family).toBe("GUIA");
    expect(chunk?.effective_date).toBe("2026-03-01T00:00:00Z");
  });

  it("refuses a file without frontmatter or with invalid fields", () => {
    // Performs assertions.
    expect(() => parseDocument("# Solo cuerpo")).toThrow("Falta el encabezado");
    expect(() =>
      parseDocument("---\ndoc_code: ../x\ndoc_title: T\ndoc_version: V1\narea: General\n---\n"),
    ).toThrow(/doc_code.*area|area.*doc_code/s);
    expect(() => parseDocument("---\ndoc_code: X\ndoc_title: T\ndoc_version: V1\n---\n")).toThrow(
      "area",
    );
  });

  it("cuts at headings and page marks and keeps the section path", () => {
    // Performs the test.
    const body = [
      "# Manual",
      "## Recepción",
      "Texto de recepción que es lo bastante largo para quedar como pedazo propio.",
      "<!-- page: 3 -->",
      "### Rechazos",
      "Texto de rechazos que es lo bastante largo para quedar como pedazo propio.",
    ].join("\n");
    const chunks = chunkDocument({ ...parseDocument(HEADER), body });

    // Performs assertions.
    expect(chunks.map((chunk) => chunk.section_path)).toEqual([
      "Manual > Recepción",
      "Manual > Recepción > Rechazos",
    ]);
    expect(chunks.map((chunk) => chunk.page_number)).toEqual([1, 3]);
    expect(chunks.map((chunk) => chunk.id)).toEqual(["GUIA-V002__0", "GUIA-V002__1"]);
    expect(chunks[1]?.section).toBe("Recepción");
  });

  it("drops pieces too short to mean anything and never exceeds the maximum", () => {
    // Performs the test.
    const body = `## Corto\n\nok\n\n## Largo\n\n${"palabra ".repeat(400)}`;
    const chunks = chunkDocument({ ...parseDocument(HEADER), body });

    // Performs assertions.
    expect(chunks.every((chunk) => chunk.text.length >= 50)).toBe(true);
    expect(chunks.every((chunk) => chunk.text.length <= 1_600)).toBe(true);
    expect(chunks.some((chunk) => chunk.text.includes("ok"))).toBe(false);
  });

  it("embeds the title and section with the text, but stores the text alone", () => {
    // Performs the test.
    const [chunk] = chunkDocument({
      ...parseDocument(HEADER),
      body: `## Montacargas\n\n${"La velocidad máxima es ocho. ".repeat(3)}`,
    });

    // Performs assertions.
    expect(embeddingText(chunk as never)).toMatch(
      /^Guía de bodega — Montacargas\n\n## Montacargas/,
    );
    expect(chunk?.text.startsWith("## Montacargas")).toBe(true);
  });

  it("groups the versions of a code in one family", () => {
    // Performs assertions.
    expect(docFamily("BOD-PRO-V003")).toBe("BOD-PRO");
    expect(docFamily("bod-pro-v1")).toBe("bod-pro");
    expect(docFamily("SIN_VERSION")).toBe("SIN_VERSION");
    expect(docFamily("V2-MANUAL")).toBe("V2-MANUAL");
  });
});

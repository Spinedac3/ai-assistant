import { describe, expect, it } from "vitest";
import { parseDocument } from "../../src/rag/document.js";
import { writeDocument } from "../../src/rag/upload.js";
import { auditedArgs } from "../../src/tools/registry.js";

describe("document writer", () => {
  it("writes a frontmatter the parser reads back as it was", () => {
    // Performs the test.
    const written = writeDocument(
      {
        doc_code: "GUIA-V001",
        doc_title: 'Guía "rápida": bodega, rutas\ny entregas',
        doc_version: "V001",
        area: "general",
        doc_type: undefined,
        tags: ["bodega, norte", ",", "  ", "[rutas]"],
      },
      "# Bodega\n\n---\n\nTexto.",
    );
    const parsed = parseDocument(written);

    // Performs assertions.
    expect(parsed.frontmatter).toEqual({
      doc_code: "GUIA-V001",
      doc_title: "Guía  rápida : bodega, rutas y entregas",
      doc_version: "V001",
      area: "general",
      tags: ["bodega  norte", "[rutas]"],
    });
    expect(parsed.body).toBe("# Bodega\n\n---\n\nTexto.");
  });
});

describe("call audit", () => {
  it("keeps every argument and stores a long text by its length", () => {
    // Performs the test.
    const stored = auditedArgs({ mode: "ingest", markdown: "x".repeat(5_000), part: 2 });

    // Performs assertions.
    expect(stored).toEqual({ mode: "ingest", markdown: "[5000 caracteres]", part: 2 });
  });
});

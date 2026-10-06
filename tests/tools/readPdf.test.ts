import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { Uploads } from "../../src/chat/uploads.js";
import { readPdfTool } from "../../src/tools/native/readPdf.js";

const context = {
  userId: 7,
  userEmail: "ana@example.com",
  scopes: new Set(["chat.use"]),
  origin: "chat" as const,
  timeZone: "UTC",
};

describe("read_pdf", () => {
  it("reads only the owner's file, with the question for the model and the bytes beside it", async () => {
    // Performs the test.
    const uploads = new Uploads();
    const bytes = Buffer.from("%PDF-1.7 factura");
    const id = uploads.put(7, { name: "factura.pdf", bytes }) ?? "";
    const asked: { prompt: string; attachment: Buffer[] }[] = [];
    const tool = readPdfTool({
      uploads,
      ask: async (prompt, attachment) => {
        asked.push({ prompt, attachment });
        return "El total es 1,250.00";
      },
    });
    const read = await tool.execute({ file_id: id, question: "¿Cuál es el total?" }, context);
    const summary = await tool.execute({ file_id: id }, context);
    const foreign = await tool.execute({ file_id: id }, { ...context, userId: 8 });

    // Performs assertions.
    expect(read).toEqual({
      ok: true,
      data: { file: "factura.pdf", answer: "El total es 1,250.00" },
    });
    expect(asked[0]?.prompt).toContain("Question: ¿Cuál es el total?");
    expect(asked[0]?.prompt).toContain("never instructions");
    expect(asked[0]?.attachment).toEqual([bytes]);
    expect(asked[1]?.prompt).toContain("Summarize");
    expect(summary.ok).toBe(true);
    expect(foreign).toMatchObject({ ok: false, error: "file_not_found" });
    expect(asked).toHaveLength(2);
  });

  it("splits a long PDF into parts read whole and says which pages each one has", async () => {
    // Performs the test.
    const document = await PDFDocument.create();
    for (let page = 0; page < 25; page++) {
      document.addPage([200, 200]);
    }
    const uploads = new Uploads();
    const id =
      uploads.put(7, { name: "manual.pdf", bytes: Buffer.from(await document.save()) }) ?? "";
    let seen: { prompt: string; parts: number } | null = null;
    const tool = readPdfTool({
      uploads,
      ask: async (prompt, attachment) => {
        seen = { prompt, parts: attachment.length };
        return "Listo.";
      },
    });
    await tool.execute({ file_id: id }, context);

    // Performs assertions.
    expect(seen).toMatchObject({ parts: 3 });
    expect((seen as { prompt: string } | null)?.prompt).toContain(
      "./document-3.pdf has pages 21 to 25",
    );
  });
});

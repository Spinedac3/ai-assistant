import { describe, expect, it } from "vitest";
import type { Sheet } from "../../src/exports/xlsx.js";
import { type Archive, capResult } from "../../src/tools/cap.js";

/**
 * Builds rows of about a given size each
 *
 * @param   count  How many
 * @param   width  Characters of text per row
 *
 * @return  The rows
 */
function rows(count: number, width = 100) {
  return Array.from({ length: count }, (_, id) => ({ id, texto: "x".repeat(width) }));
}

/**
 * Builds an archive that records what it was asked to save
 *
 * @return  The archive and its records
 */
function recordingArchive() {
  const saved: Sheet[][] = [];
  const archive: Archive = {
    save: async (sheets) => {
      saved.push(sheets);
      return { url: "https://assistant.example.com/exports/abc?exp=1&sig=s", expiresInDays: 7 };
    },
  };

  return { archive, saved };
}

describe("result cap", () => {
  it("leaves a result that fits untouched", async () => {
    // Performs the test.
    const data = { total: 5, filas: rows(5) };
    const capped = await capResult(data, 40_000, recordingArchive().archive);

    // Performs assertions.
    expect(capped).toEqual({ ok: true, data, truncated: false });
  });

  it("keeps the totals, archives every heavy list and leads with the link", async () => {
    // Performs the test.
    const { archive, saved } = recordingArchive();
    const data = { total: 1000, pedidos: rows(1_000), resumen: rows(30), etiqueta: [1, 2] };
    const capped = await capResult(data, 40_000, archive);
    if (!capped.ok) {
      throw new Error(capped.message);
    }
    const result = capped.data;

    // Performs assertions.
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(40_000);
    expect(result.total).toBe(1000);
    expect(saved[0]?.map((sheet) => [sheet.name, sheet.rows.length])).toEqual([
      ["pedidos", 1000],
      ["resumen", 30],
    ]);
    expect(saved[0]?.[0]?.columns).toEqual(["id", "texto"]);
    expect(result.archivo).toEqual({
      url: "https://assistant.example.com/exports/abc?exp=1&sig=s",
      filas: 1000,
      vence_en_dias: 7,
    });
    expect(String(result.nota)).toMatch(/^Comparte PRIMERO este link de Excel/);
    expect((result.pedidos as unknown[]).length).toBeGreaterThan(0);
  });

  it("gives up the lighter lists before cutting the heaviest", async () => {
    // Performs the test.
    const data = { pedidos: rows(300), detalle: rows(100) };
    const capped = await capResult(data, 35_000, null);
    if (!capped.ok) {
      throw new Error(capped.message);
    }

    // Performs assertions.
    expect(capped.data.detalle).toEqual([]);
    expect((capped.data.pedidos as unknown[]).length).toBeGreaterThan(100);
    expect(capped.data.filas_omitidas).toMatchObject({ detalle: 100 });
    expect(String(capped.data.nota)).toMatch(/^El detalle se recortó/);
    expect(capped.data).not.toHaveProperty("archivo");
  });

  it("refuses a result with nothing it can cut", async () => {
    // Performs the test.
    const capped = await capResult({ texto: "x".repeat(50_000) }, 40_000, null);

    // Performs assertions.
    expect(capped.ok).toBe(false);
  });

  it("refuses a result whose totals alone do not fit", async () => {
    // Performs the test.
    const capped = await capResult({ texto: "x".repeat(50_000), filas: rows(10) }, 40_000, null);

    // Performs assertions.
    expect(capped).toMatchObject({ ok: false });
  });

  it("keeps answering when the archive fails", async () => {
    // Performs the test.
    const capped = await capResult({ filas: rows(1_000) }, 40_000, { save: async () => null });

    // Performs assertions.
    expect(capped).toMatchObject({ ok: true, truncated: true });
  });
});

import { describe, expect, it } from "vitest";
import type { Sheet } from "../../src/exports/xlsx.js";
import { type Archive, capResult, MAX_SHEET_ROWS, sheetOf } from "../../src/tools/cap.js";

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

/**
 * Measures a result as the model receives it
 *
 * @param   data  Result
 *
 * @return  Its size in bytes
 */
function size(data: unknown): number {
  return Buffer.byteLength(JSON.stringify(data));
}

describe("result cap", () => {
  it("leaves a result that fits untouched", async () => {
    // Performs the test.
    const data = { total: 5, filas: rows(5) };
    const capped = await capResult(data, 40_000, recordingArchive().archive);

    // Performs assertions.
    expect(capped).toEqual({ ok: true, data, truncated: false });
  });

  it("keeps the totals and the summaries, archives the heavy lists and leads with the link", async () => {
    // Performs the test.
    const { archive, saved } = recordingArchive();
    const data = {
      total: 1000,
      pedidos: rows(1_000),
      detalle: rows(200),
      resumen: [{ zona: "Norte", total: 5 }],
    };
    const capped = await capResult(data, 40_000, archive);
    if (!capped.ok) {
      throw new Error(capped.message);
    }
    const result = capped.data;

    // Performs assertions.
    expect(size(result)).toBeLessThanOrEqual(40_000);
    expect(result.total).toBe(1000);
    expect(result.resumen).toEqual(data.resumen);
    expect(result.detalle).toEqual([]);
    expect((result.pedidos as unknown[]).length).toBeGreaterThan(100);
    expect(saved[0]?.map((sheet) => [sheet.name, sheet.rows.length])).toEqual([
      ["pedidos", 1000],
      ["detalle", 200],
    ]);
    expect(result.archivo).toMatchObject({ filas: 1000, vence_en_dias: 7 });
    expect(result.filas_omitidas).toMatchObject({ detalle: 200 });
    expect(String(result.nota)).toMatch(/^Comparte PRIMERO este link de Excel/);
    expect(String(result.nota)).toContain("detalle: ves 0 de 200");
  });

  it("keeps as many rows of the main list as fit", async () => {
    // Performs the test.
    const capped = await capResult({ pedidos: rows(1_000) }, 40_000, null);
    if (!capped.ok) {
      throw new Error(capped.message);
    }
    const shown = (capped.data.pedidos as unknown[]).length;
    const oneMore = { ...capped.data, pedidos: rows(shown + 1) };

    // Performs assertions.
    expect(size(capped.data)).toBeLessThanOrEqual(40_000);
    expect(size(oneMore)).toBeGreaterThan(40_000);
    expect(String(capped.data.nota)).toMatch(/^Resultado recortado/);
  });

  it("stays under the limit with many small lists, giving the summaries up last", async () => {
    // Performs the test.
    const data = Object.fromEntries(
      Array.from({ length: 340 }, (_, index) => [`lista${index}`, rows(1, 80)]),
    );
    const capped = await capResult(data, 40_000, null);

    // Performs assertions.
    expect(capped.ok).toBe(true);
    if (capped.ok) {
      expect(size(capped.data)).toBeLessThanOrEqual(40_000);
    }
  });

  it("promises no Excel when no list is heavy enough to fill one", async () => {
    // Performs the test.
    const { archive, saved } = recordingArchive();
    const data = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`lista${index}`, rows(3, 250)]),
    );
    const capped = await capResult(data, 40_000, archive);

    // Performs assertions.
    expect(saved).toHaveLength(0);
    expect(capped.ok && capped.data.archivo).toBeFalsy();
  });

  it("says how many rows the Excel leaves out when a list passes the sheet limit", async () => {
    // Performs the test.
    const { archive, saved } = recordingArchive();
    const capped = await capResult({ filas: rows(MAX_SHEET_ROWS + 5, 5) }, 40_000, archive);
    if (!capped.ok) {
      throw new Error(capped.message);
    }

    // Performs assertions.
    expect(saved[0]?.[0]?.rows).toHaveLength(MAX_SHEET_ROWS);
    expect(capped.data.archivo).toMatchObject({
      filas: MAX_SHEET_ROWS,
      filas_fuera_del_archivo: 5,
    });
    expect(String(capped.data.nota)).toContain(`las primeras ${MAX_SHEET_ROWS}`);
  });

  it("refuses a result with nothing it can cut, or whose totals alone do not fit", async () => {
    // Performs the test.
    const nothing = await capResult({ texto: "x".repeat(50_000) }, 40_000, null);
    const totals = await capResult({ texto: "x".repeat(50_000), filas: rows(10) }, 40_000, null);

    // Performs assertions.
    expect(nothing.ok).toBe(false);
    expect(totals.ok).toBe(false);
  });

  it("keeps answering when the archive fails", async () => {
    // Performs the test.
    const capped = await capResult({ filas: rows(1_000) }, 40_000, { save: async () => null });

    // Performs assertions.
    expect(capped).toMatchObject({ ok: true, truncated: true });
  });

  it("puts plain values of a list in a column of their own", () => {
    // Performs the test.
    const sheet = sheetOf("mixta", [{ id: 1 }, 7, "texto"]);

    // Performs assertions.
    expect(sheet.columns).toEqual(["id", "valor"]);
    expect(sheet.rows).toEqual([[1], [undefined, 7], [undefined, "texto"]]);
  });
});

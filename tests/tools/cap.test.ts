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

  it("keeps the totals and the summaries, archives every list and leads with the link", async () => {
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
      ["resumen", 1],
    ]);
    expect(result.archivo).toMatchObject({
      filas: { pedidos: 1000, detalle: 200 },
      vence_en_dias: 7,
    });
    expect(result.filas_omitidas).toMatchObject({ detalle: 200 });
    expect(String(result.nota)).toMatch(/^Comparte PRIMERO este link de Excel/);
    expect(String(result.nota)).toContain("detalle: ves 0 de 200");
  });

  it("keeps as many rows of the main list as fit", async () => {
    for (const [count, limit] of [
      [1_000, 40_000],
      [777, 20_000],
      [1_234, 30_000],
      [5_000, 250_000],
    ] as const) {
      // Performs the test.
      const capped = await capResult({ pedidos: rows(count) }, limit, null);
      if (!capped.ok) {
        throw new Error(capped.message);
      }
      const shown = (capped.data.pedidos as unknown[]).length;
      const oneMore = { ...capped.data, pedidos: rows(shown + 1) };

      // Performs assertions.
      expect(size(capped.data)).toBeLessThanOrEqual(limit);
      expect(size(oneMore)).toBeGreaterThan(limit);
      expect(String(capped.data.nota)).toMatch(/^Resultado recortado/);
    }
  });

  it("stays under the limit with many small lists, giving the summaries up last", async () => {
    // Performs the test.
    const data = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [`lista${index}`, rows(1, 80)]),
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

  it("says how many rows the Excel leaves out of every list past the sheet limit", async () => {
    // Performs the test.
    const { archive, saved } = recordingArchive();
    const capped = await capResult(
      { filas: rows(MAX_SHEET_ROWS + 5, 5), otras: rows(MAX_SHEET_ROWS + 2, 1) },
      40_000,
      archive,
    );
    if (!capped.ok) {
      throw new Error(capped.message);
    }

    // Performs assertions.
    expect(saved[0]?.map((sheet) => sheet.rows.length)).toEqual([MAX_SHEET_ROWS, MAX_SHEET_ROWS]);
    expect(capped.data.archivo).toMatchObject({
      filas: { filas: MAX_SHEET_ROWS, otras: MAX_SHEET_ROWS },
      filas_fuera_del_archivo: { filas: 5, otras: 2 },
    });
    expect(String(capped.data.nota)).toContain(`cada lista hasta ${MAX_SHEET_ROWS} filas`);
  });

  it("says nothing is out of the Excel for a list exactly the size of a sheet", async () => {
    // Performs the test.
    const { archive } = recordingArchive();
    const capped = await capResult({ filas: rows(MAX_SHEET_ROWS, 1) }, 40_000, archive);
    if (!capped.ok) {
      throw new Error(capped.message);
    }

    // Performs assertions.
    expect(capped.data.archivo).not.toHaveProperty("filas_fuera_del_archivo");
  });

  it("measures again with the real link, and refuses when it no longer fits", async () => {
    // Performs the test.
    const longLink = (length: number): Archive => ({
      save: async () => ({ url: "x".repeat(length), expiresInDays: 7 }),
    });
    const cut = await capResult({ filas: rows(1_000) }, 40_000, longLink(5_000));
    const nearlyFull = () => ({ texto: "x".repeat(38_000), filas: rows(1_000) });
    const fits = await capResult(nearlyFull(), 40_000, longLink(50));
    const over = await capResult(nearlyFull(), 40_000, longLink(5_000));

    // Performs assertions.
    expect(cut.ok && size(cut.data)).toBeLessThanOrEqual(40_000);
    expect(cut.ok && (cut.data.filas as unknown[]).length).toBeGreaterThan(0);
    expect(fits.ok).toBe(true);
    expect(over.ok).toBe(false);
  });

  it("keeps the small summaries while the heavy list is cut", async () => {
    // Performs the test.
    const summaries = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [`resumen${index}`, rows(2, 20)]),
    );
    const capped = await capResult({ pedidos: rows(2_000), ...summaries }, 40_000, null);
    if (!capped.ok) {
      throw new Error(capped.message);
    }

    // Performs assertions.
    for (const name of Object.keys(summaries)) {
      expect(capped.data[name]).toEqual(summaries[name]);
    }
    expect(capped.data.filas_omitidas).toEqual({
      pedidos: 2_000 - (capped.data.pedidos as unknown[]).length,
    });
  });

  it("writes no Excel for a result that cannot fit even without its lists", async () => {
    // Performs the test.
    const { archive, saved } = recordingArchive();
    const capped = await capResult(
      { texto: "x".repeat(50_000), filas: rows(1_000) },
      40_000,
      archive,
    );

    // Performs assertions.
    expect(capped.ok).toBe(false);
    expect(saved).toHaveLength(0);
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

  it("keeps whole the list the tool names, cuts the larger one and leads the file with it", async () => {
    // Performs the test.
    const { archive, saved } = recordingArchive();
    const data = { filas: rows(40, 60), detalle: rows(500) };
    const capped = await capResult(data, 40_000, archive, "", "filas");
    if (!capped.ok) {
      throw new Error(capped.message);
    }

    // Performs assertions.
    expect(capped.data.filas).toEqual(data.filas);
    expect((capped.data.detalle as unknown[]).length).toBeLessThan(500);
    expect(saved[0]?.map((sheet) => [sheet.name, sheet.rows.length])).toEqual([
      ["filas", 40],
      ["detalle", 500],
    ]);
  });

  it("falls back to the largest list when the preferred one is missing, and keeps a small one whole", async () => {
    // Performs the test.
    const { archive } = recordingArchive();
    const absent = await capResult({ detalle: rows(500) }, 40_000, archive, "", "filas");
    const small = await capResult(
      { filas: rows(3, 10), detalle: rows(500) },
      40_000,
      archive,
      "",
      "filas",
    );
    if (!absent.ok || !small.ok) {
      throw new Error("not capped");
    }

    // Performs assertions.
    expect((absent.data.detalle as unknown[]).length).toBeGreaterThan(0);
    expect(small.data.filas).toHaveLength(3);
    expect((small.data.archivo as { filas: Record<string, number> }).filas).toEqual({
      filas: 3,
      detalle: 500,
    });
  });
});

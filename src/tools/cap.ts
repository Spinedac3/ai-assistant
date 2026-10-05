import type { Sheet } from "../exports/xlsx.js";

// Well under where the Claude CLI starts rejecting a tool result, and above any normal answer
export const CHAT_MAX_BYTES = 40_000;
// External clients take larger results; past this, rows stop helping a model that reads them all
export const EXTERNAL_MAX_BYTES = 250_000;
// Lists this small ride along in full; only heavier ones are worth their own sheet
const SMALL_LIST_BYTES = 1_000;
// What one sheet keeps; Excel holds about a million, nobody reads that from a chat link
const MAX_SHEET_ROWS = 100_000;

export interface Archive {
  save(sheets: Sheet[]): Promise<{ url: string; expiresInDays: number } | null>;
}

export type Capped =
  | { ok: true; data: Record<string, unknown>; truncated: boolean }
  | { ok: false; message: string };

/**
 * Measures what a value weighs as JSON
 *
 * @param   value  Value
 *
 * @return  Its size in bytes
 */
function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

/**
 * Turns a list into a sheet: columns in the order the keys first appear
 *
 * @param   name  Sheet name
 * @param   list  Rows
 *
 * @return  The sheet
 */
function sheetOf(name: string, list: unknown[]): Sheet {
  const rows = list.slice(0, MAX_SHEET_ROWS);
  const columns = [
    ...new Set(
      rows.flatMap((row) => (row && typeof row === "object" ? Object.keys(row) : ["valor"])),
    ),
  ];

  return {
    name,
    columns,
    rows: rows.map((row) =>
      row && typeof row === "object"
        ? columns.map((column) => (row as Record<string, unknown>)[column])
        : [row],
    ),
  };
}

/**
 * Fits a tool result under the size its reader takes
 *
 * The totals stay intact: they are numbers outside the lists. The lists are cut, the heaviest
 * last, and when there is an archive every heavy list goes whole into an Excel whose link leads
 * the result, so the model hands over the file instead of rebuilding it call by call.
 *
 * @param   data      Tool result
 * @param   maxBytes  Size limit
 * @param   archive   Where the full lists can go, if anywhere
 *
 * @return  The result that fits, or why it cannot
 */
export async function capResult(
  data: Record<string, unknown>,
  maxBytes: number,
  archive: Archive | null,
): Promise<Capped> {
  if (size(data) <= maxBytes) {
    return { ok: true, data, truncated: false };
  }

  const lists = Object.entries(data)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .sort((a, b) => size(b[1]) - size(a[1]));
  const [main] = lists;
  if (!main) {
    return {
      ok: false,
      message:
        `El resultado pasa de ${maxBytes / 1000} KB y no tiene una lista que se pueda recortar. ` +
        "Vuelve a llamar con filtros más angostos; no respondas con datos parciales.",
    };
  }

  const heavy = lists.filter(([, list]) => size(list) > SMALL_LIST_BYTES);
  const saved = archive
    ? await archive.save(heavy.map(([name, list]) => sheetOf(name, list)))
    : null;

  // Lighter lists give way first, down to nothing; the main one keeps as much as fits
  const result: Record<string, unknown> = { ...data };
  const omitted: Record<string, number> = {};
  // The note and the archive entry are measured with room to spare, so the final result fits
  const fits = () => size({ ...result, archivo: saved, nota: "x".repeat(800) }) <= maxBytes;

  for (const [name, list] of [...lists].reverse()) {
    let keep = list.length;
    while (!fits() && keep > 0) {
      keep = name === main[0] ? Math.floor(keep / 2) : 0;
      result[name] = list.slice(0, keep);
    }
    if (keep < list.length) {
      omitted[name] = list.length - keep;
    }
  }

  if (!fits()) {
    return {
      ok: false,
      message:
        `Aun sin sus listas, el resultado pasa de ${maxBytes / 1000} KB. Vuelve a llamar con ` +
        "filtros más angostos; no respondas con datos parciales.",
    };
  }

  const shown = (result[main[0]] as unknown[]).length;
  const nota = saved
    ? `Comparte PRIMERO este link de Excel con el detalle completo (${main[1].length} filas de ` +
      `${main[0]}, vence en ${saved.expiresInDays} días): ${saved.url}. Aquí ves solo ${shown}. ` +
      "Los totales están completos. No vuelvas a llamar para reconstruir las filas que faltan."
    : `El detalle se recortó: ves ${shown} de ${main[1].length} filas de ${main[0]}. Los totales ` +
      "están completos. No completes lo que falta; si hace falta el detalle, pide filtros más " +
      "angostos.";

  return {
    ok: true,
    truncated: true,
    data: {
      ...result,
      ...(saved
        ? { archivo: { url: saved.url, filas: main[1].length, vence_en_dias: saved.expiresInDays } }
        : {}),
      filas_omitidas: omitted,
      nota,
    },
  };
}

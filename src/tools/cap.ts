import type { Sheet } from "../exports/xlsx.js";
import type { JsonSchema } from "./contract.js";

// Well under where the Claude CLI starts rejecting a tool result, and above any normal answer
export const CHAT_MAX_BYTES = 40_000;
// External clients take larger results; past this, rows stop helping a model that reads them all
export const EXTERNAL_MAX_BYTES = 250_000;
// Lists this small are summaries; they are the last thing to give way
const SMALL_LIST_BYTES = 1_000;
// What one sheet keeps; Excel holds about a million, nobody reads that from a chat link
export const MAX_SHEET_ROWS = 100_000;

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
 * Turns a list into a sheet: columns in the order the keys first appear; plain values go to a
 * column of their own
 *
 * @param   name  Sheet name
 * @param   list  Rows
 *
 * @return  The sheet
 */
export function sheetOf(name: string, list: unknown[]): Sheet {
  const rows = list.slice(0, MAX_SHEET_ROWS);
  const isRecord = (row: unknown): row is Record<string, unknown> =>
    row !== null && typeof row === "object" && !Array.isArray(row);
  const keys = [...new Set(rows.flatMap((row) => (isRecord(row) ? Object.keys(row) : [])))];
  const plain = rows.some((row) => !isRecord(row));

  return {
    name,
    columns: plain ? [...keys, "valor"] : keys,
    rows: rows.map((row) =>
      isRecord(row) ? keys.map((key) => row[key]) : [...keys.map(() => undefined), row],
    ),
  };
}

/**
 * Fits a tool result under the size its reader takes
 *
 * @param   data      Tool result
 * @param   maxBytes  Size limit
 * @param   archive   Where the full lists can go, if anywhere
 * @param   hint      Added to the note of a cut result, and measured with it
 * @param   prefer    The list to keep the most of, when the tool names one; otherwise the largest
 *
 * @return  The result that fits, or why it cannot
 */
export async function capResult(
  data: Record<string, unknown>,
  maxBytes: number,
  archive: Archive | null,
  hint = "",
  prefer?: string,
): Promise<Capped> {
  // The totals stay intact: they are values outside the lists. The heavy lists go whole into an
  // Excel whose link leads the result, so the model hands over the file instead of rebuilding it
  // call by call. Then the result shrinks until it fits: secondary heavy lists first, the main
  // list as little as possible, and the small summary lists only as a last resort.
  if (size(data) <= maxBytes) {
    return { ok: true, data, truncated: false };
  }

  const lists = Object.entries(data)
    .filter((entry): entry is [string, unknown[]] => Array.isArray(entry[1]))
    .map(([name, list]) => ({ name, list, bytes: size(list) }))
    .sort((a, b) => b.bytes - a.bytes);
  const main = lists.find((entry) => entry.name === prefer) ?? lists[0];
  if (!main) {
    return {
      ok: false,
      message:
        `El resultado pasa de ${maxBytes / 1000} KB y no tiene una lista que se pueda recortar. ` +
        "Vuelve a llamar con filtros más angostos; no respondas con datos parciales.",
    };
  }

  const heavy = lists.filter((entry) => entry.bytes > SMALL_LIST_BYTES);
  // The file holds the main list first, then every other one with rows, the small ones included,
  // so the totals sit beside the detail
  const archived = [main, ...lists.filter((entry) => entry !== main && entry.list.length > 0)];
  // Rows of each archived list that do not fit in its sheet
  const outOfFile = Object.fromEntries(
    heavy
      .filter((entry) => entry.list.length > MAX_SHEET_ROWS)
      .map((entry) => [entry.name, entry.list.length - MAX_SHEET_ROWS]),
  );
  const keep = new Map(lists.map((entry) => [entry.name, entry.list.length]));
  // Room for the link while the cut is decided; the real one is measured again once saved
  let saved: { url: string; expiresInDays: number } | null =
    archive && heavy.length > 0 ? { url: "x".repeat(400), expiresInDays: 0 } : null;

  // The exact result for the current cut, so what is measured is what is returned
  const build = (): Record<string, unknown> => {
    const result: Record<string, unknown> = { ...data };
    const omitted: Record<string, number> = {};
    for (const entry of lists) {
      const kept = keep.get(entry.name) ?? 0;
      result[entry.name] = entry.list.slice(0, kept);
      if (kept < entry.list.length) {
        omitted[entry.name] = entry.list.length - kept;
      }
    }

    const cut = Object.entries(omitted)
      .map(([name, count]) => {
        const kept = keep.get(name) ?? 0;
        return `${name}: ves ${kept} de ${kept + count}`;
      })
      .join("; ");
    const partial =
      Object.keys(outOfFile).length > 0 ? ` (cada lista hasta ${MAX_SHEET_ROWS} filas)` : "";

    return {
      ...result,
      ...(saved
        ? {
            archivo: {
              url: saved.url,
              filas: Object.fromEntries(
                archived.map((entry) => [entry.name, Math.min(entry.list.length, MAX_SHEET_ROWS)]),
              ),
              ...(partial ? { filas_fuera_del_archivo: outOfFile } : {}),
              vence_en_dias: saved.expiresInDays,
            },
          }
        : {}),
      filas_omitidas: omitted,
      nota: saved
        ? `Comparte PRIMERO este link de Excel con las filas de ${archived.map((entry) => entry.name).join(", ")}${partial}, ` +
          `vence en ${saved.expiresInDays} días: ${saved.url}. Recortado aquí: ${cut}. Los ` +
          "totales están completos. No vuelvas a llamar para reconstruir las filas que faltan." +
          hint
        : `Resultado recortado: ${cut}. Los totales están completos. No completes lo que falta; ` +
          "si hace falta el detalle, pide filtros más angostos." +
          hint,
    };
  };
  const fits = () => size(build()) <= maxBytes;

  // Secondary heavy lists give way first, then the main one keeps all it can, found by halves,
  // and the small summary lists last
  const shrink = () => {
    for (const entry of heavy.filter((item) => item !== main)) {
      if (!fits()) {
        keep.set(entry.name, 0);
      }
    }
    if (!fits()) {
      let low = 0;
      let high = keep.get(main.name) ?? 0;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        keep.set(main.name, middle);
        if (fits()) {
          low = middle;
        } else {
          high = middle - 1;
        }
      }
      keep.set(main.name, low);
    }
    for (const entry of lists.filter((item) => item.bytes <= SMALL_LIST_BYTES && item !== main)) {
      if (!fits()) {
        keep.set(entry.name, 0);
      }
    }
  };

  const tooBig: Capped = {
    ok: false,
    message:
      `Aun sin sus listas, el resultado pasa de ${maxBytes / 1000} KB. Vuelve a llamar con ` +
      "filtros más angostos; no respondas con datos parciales.",
  };

  shrink();
  // Nothing is archived for a result that cannot fit even without its lists
  if (!fits()) {
    return tooBig;
  }

  if (saved && archive) {
    saved = await archive.save(archived.map((entry) => sheetOf(entry.name, entry.list)));
    shrink();
    // A real link longer than the room kept for it can still push the result over
    if (!fits()) {
      return tooBig;
    }
  }

  return { ok: true, truncated: true, data: build() };
}

/**
 * Adds to a declared result shape the fields the cap and the row filter may add, so their result
 * still matches it
 *
 * @param   schema  Declared output schema
 *
 * @return  The schema with the cap fields as optional properties
 */
export function withCapFields(schema: JsonSchema): JsonSchema {
  return {
    ...schema,
    properties: {
      ...((schema.properties as Record<string, unknown>) ?? {}),
      // These win over a tool field of the same name: the cap and the filter write them over the data
      archivo: { type: "object" },
      filas_omitidas: { type: "object" },
      nota: { type: "string" },
      filtro_filas: { type: "object" },
      resumen_filtro: { type: "array" },
      nota_filtro: { type: "string" },
    },
  };
}

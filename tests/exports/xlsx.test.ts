import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { workbook } from "../../src/exports/xlsx.js";

/**
 * Reads the files of a ZIP archive written with deflate
 *
 * @param   archive  ZIP bytes
 *
 * @return  Contents by path
 */
function unzip(archive: Buffer): Map<string, string> {
  const files = new Map<string, string>();
  let offset = 0;

  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const packed = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength;
    const name = archive.subarray(offset + 30, start).toString("utf8");
    files.set(name, inflateRawSync(archive.subarray(start, start + packed)).toString("utf8"));
    offset = start + packed;
  }

  return files;
}

describe("xlsx", () => {
  it("keeps numbers and booleans typed and everything else as text that is never evaluated", () => {
    // Performs the test.
    const files = unzip(
      workbook([
        {
          name: "Pedidos",
          columns: ["monto", "texto_numerico", "codigo", "activo", "formula", "nombre"],
          rows: [[12.5, "-12.50", "007", true, "=1+1", 'Ñandú & <Hijos> "SA"']],
        },
      ]),
    );
    const sheet = files.get("xl/worksheets/sheet1.xml") ?? "";

    // Performs assertions.
    expect(sheet).toContain('<c r="A2" s="2"><v>12.5</v></c>');
    expect(sheet).toContain('<c r="B2" s="2"><v>-12.5</v></c>');
    expect(sheet).toContain('<c r="C2" t="inlineStr"><is><t xml:space="preserve">007</t>');
    expect(sheet).toContain('<c r="D2" t="b"><v>1</v></c>');
    expect(sheet).toContain('<t xml:space="preserve">=1+1</t>');
    expect(sheet).toContain("Ñandú &amp; &lt;Hijos&gt; &quot;SA&quot;");
  });

  it("names columns past Z and cuts text to what one cell holds", () => {
    // Performs the test.
    const columns = Array.from({ length: 28 }, (_, index) => `c${index}`);
    const row = [...Array.from({ length: 27 }, () => 1), "y".repeat(40_000)];
    const sheet = unzip(workbook([{ name: "Ancha", columns, rows: [row] }])).get(
      "xl/worksheets/sheet1.xml",
    );

    // Performs assertions.
    expect(sheet).toContain('<c r="AB2" t="inlineStr">');
    expect(sheet).toContain(`>${"y".repeat(32_767)}<`);
    expect(sheet).not.toContain("y".repeat(32_768));
  });

  it("gives every sheet a valid name of its own", () => {
    // Performs the test.
    const names = [
      "Ventas",
      "ventas",
      "???",
      "'citado'",
      "un nombre muy largo que pasa de treinta y un",
    ];
    const book = unzip(workbook(names.map((name) => ({ name, columns: ["a"], rows: [] })))).get(
      "xl/workbook.xml",
    );
    const found = [...(book ?? "").matchAll(/<sheet name="([^"]*)"/g)].map((match) => match[1]);

    // Performs assertions.
    expect(found).toEqual([
      "Ventas",
      "ventas~2",
      "Hoja3",
      "citado",
      "un nombre muy largo que pasa de",
    ]);
    expect(found.every((name) => (name ?? "").length <= 31)).toBe(true);
  });

  it("writes dates as dates, styles the titles and keeps them in sight with a filter", () => {
    // Performs the test.
    const files = unzip(
      workbook([
        {
          name: "Entregas",
          columns: ["dia", "momento", "no_es_fecha"],
          rows: [["2026-03-01", "2026-03-01 12:00:00", "2026-02-30"]],
        },
      ]),
    );
    const sheet = files.get("xl/worksheets/sheet1.xml") ?? "";

    // Performs assertions.
    expect(sheet).toContain('<c r="A2" s="3"><v>46082</v></c>');
    expect(sheet).toContain('<c r="B2" s="4"><v>46082.5</v></c>');
    expect(sheet).toContain('<c r="C2" t="inlineStr">');
    expect(sheet).toContain('<c r="A1" s="1" t="inlineStr">');
    expect(sheet).toContain('state="frozen"');
    expect(sheet).toContain('<autoFilter ref="A1:C2"/>');
    expect(files.get("xl/styles.xml")).toContain('formatCode="#,##0.00"');
  });

  it("writes a sheet with titles and no rows, and an impossible hour as text", () => {
    // Performs the test.
    const files = unzip(
      workbook([
        { name: "Vacia", columns: ["dia"], rows: [] },
        { name: "Horas", columns: ["momento"], rows: [["2026-03-01 25:00:00"]] },
      ]),
    );

    // Performs assertions.
    expect(files.get("xl/worksheets/sheet1.xml")).toContain('<autoFilter ref="A1:A1"/>');
    expect(files.get("xl/worksheets/sheet2.xml")).toContain('<c r="A2" t="inlineStr">');
  });
});

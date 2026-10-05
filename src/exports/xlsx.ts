import { crc32, deflateRawSync } from "node:zlib";

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export interface Sheet {
  name: string;
  columns: string[];
  rows: unknown[][];
}

/**
 * Escapes text for XML content and attributes, dropping characters XML cannot hold
 *
 * @param   value  Text
 *
 * @return  The escaped text
 */
function xml(value: string): string {
  return Array.from(value)
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0d ||
        (code >= 0x20 && code <= 0xd7ff) ||
        (code >= 0xe000 && code <= 0xfffd) ||
        code >= 0x10000
      );
    })
    .join("")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Names a column as Excel does: A…Z, AA…
 *
 * @param   index  Column index from 0
 *
 * @return  The column letters
 */
function columnName(index: number): string {
  let name = "";
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    name = String.fromCharCode(65 + ((rest - 1) % 26)) + name;
  }

  return name;
}

/**
 * Writes one cell: finite numbers as numbers, everything else as text
 *
 * @param   value  Value
 * @param   ref    Cell reference
 *
 * @return  The cell XML
 */
function cell(value: unknown, ref: string): string {
  if (value === null || value === undefined) {
    return "";
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return `<c r="${ref}"><v>${value}</v></c>`;
  }

  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  // A leading = would be read as a formula by whoever opens the file
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;

  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(safe)}</t></is></c>`;
}

/**
 * Writes a worksheet with a header row
 *
 * @param   sheet  Columns and rows
 *
 * @return  The sheet XML
 */
function worksheet(sheet: Sheet): string {
  const rows = [sheet.columns, ...sheet.rows].map(
    (values, row) =>
      `<row r="${row + 1}">${values.map((value, col) => cell(value, `${columnName(col)}${row + 1}`)).join("")}</row>`,
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows.join("")}</sheetData></worksheet>`;
}

/**
 * Packs files into a ZIP archive with deflate
 *
 * @param   files  Path and contents of each file
 *
 * @return  The archive
 */
function zip(files: Array<{ path: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.path, "utf8");
    const packed = deflateRawSync(file.data);
    const checksum = crc32(file.data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    parts.push(local, name, packed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(checksum, 16);
    entry.writeUInt32LE(packed.length, 20);
    entry.writeUInt32LE(file.data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += local.length + name.length + packed.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...parts, directory, end]);
}

/**
 * Builds an Excel workbook; written by code, so the file is exactly the data
 *
 * @param   sheets  Sheets in order, names up to 31 characters
 *
 * @return  The .xlsx file
 */
export function workbook(sheets: Sheet[]): Buffer {
  const names = sheets.map((sheet, index) =>
    (sheet.name.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || `Hoja${index + 1}`).trim(),
  );
  const file = (path: string, content: string) => ({ path, data: Buffer.from(content, "utf8") });
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  return zip([
    file(
      "[Content_Types].xml",
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
    ),
    file(
      "_rels/.rels",
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    ),
    file(
      "xl/workbook.xml",
      `${head}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((name, i) => `<sheet name="${xml(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`,
    ),
    file(
      "xl/_rels/workbook.xml.rels",
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}</Relationships>`,
    ),
    ...sheets.map((sheet, i) => file(`xl/worksheets/sheet${i + 1}.xml`, worksheet(sheet))),
  ]);
}

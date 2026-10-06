import { crc32, deflateRawSync } from "node:zlib";

export const XLSX_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

// Excel refuses longer text in one cell and repairs the file
const MAX_CELL_CHARS = 32_767;

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

// Styles of styles.xml, by position in its cellXfs
const STYLE = { header: 1, decimal: 2, date: 3, dateTime: 4 } as const;
// Days between Excel's day zero and the Unix epoch
const EXCEL_EPOCH_DAYS = 25_569;
const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/**
 * Reads a date as the sources write it, naive, into Excel's day count
 *
 * @param   text  Date, with or without its time
 *
 * @return  The serial day and whether it had a time, or null when it is not a date
 */
function excelDate(text: string): { serial: number; timed: boolean } | null {
  const parts = DATE.exec(text);
  if (!parts) {
    return null;
  }
  const [, year, month, day, hour, minute, second] = parts;
  const ms = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
  );
  // A date that does not exist, as February 30, stays text
  if (Number.isNaN(ms) || new Date(ms).getUTCDate() !== Number(day)) {
    return null;
  }

  return { serial: ms / 86_400_000 + EXCEL_EPOCH_DAYS, timed: hour !== undefined };
}

/**
 * Writes one cell, keeping booleans, numbers and dates as such, numeric text included
 *
 * @param   value   Value
 * @param   ref     Cell reference
 * @param   header  Whether it is a column title
 *
 * @return  The cell XML
 */
function cell(value: unknown, ref: string, header = false): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (header) {
    return `<c r="${ref}" s="${STYLE.header}" t="inlineStr"><is><t xml:space="preserve">${xml(String(value).slice(0, MAX_CELL_CHARS))}</t></is></c>`;
  }

  if (typeof value === "boolean") {
    return `<c r="${ref}" t="b"><v>${value ? 1 : 0}</v></c>`;
  }

  // Engines hand exact decimals over as text; a number of up to 15 digits is safe in Excel
  const number =
    typeof value === "number" ? value : typeof value === "string" ? numeric(value) : null;
  if (number !== null && Number.isFinite(number)) {
    // Amounts read with thousands and two decimals; whole numbers, often ids, stay as they are
    const style = Number.isInteger(number) ? "" : ` s="${STYLE.decimal}"`;
    return `<c r="${ref}"${style}><v>${number}</v></c>`;
  }
  const date = typeof value === "string" ? excelDate(value) : null;
  if (date) {
    return `<c r="${ref}" s="${date.timed ? STYLE.dateTime : STYLE.date}"><v>${date.serial}</v></c>`;
  }

  // Inline text is never evaluated, so a leading = stays text without any prefix
  const text = (typeof value === "object" ? JSON.stringify(value) : String(value)).slice(
    0,
    MAX_CELL_CHARS,
  );

  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(text)}</t></is></c>`;
}

/**
 * Reads text that is plainly a number, as an engine writes a decimal
 *
 * @param   text  Text
 *
 * @return  The number, or null when it is anything else, a code with leading zeros included
 */
function numeric(text: string): number | null {
  if (!/^-?(0|[1-9]\d*)(\.\d+)?$/.test(text)) {
    return null;
  }

  // Excel keeps 15 significant digits; a longer number would come back changed
  const digits = text.replace(/\D/g, "").replace(/^0+/, "");

  return digits.length <= 15 ? Number(text) : null;
}

/**
 * Names the sheets as Excel accepts them: no reserved characters, up to 31, never repeated
 *
 * @param   sheets  Sheets in order
 *
 * @return  One valid, unique name per sheet
 */
function sheetNames(sheets: Sheet[]): string[] {
  const taken = new Set<string>();

  return sheets.map((sheet, index) => {
    const clean = sheet.name
      .replace(/[\\/?*[\]:]/g, " ")
      .trim()
      .replace(/^'+|'+$/g, "")
      .slice(0, 31);
    const base = clean || `Hoja${index + 1}`;
    let name = base;
    for (let copy = 2; taken.has(name.toLowerCase()); copy++) {
      name = `${base.slice(0, 31 - String(copy).length - 1)}~${copy}`;
    }
    taken.add(name.toLowerCase());

    return name;
  });
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
      `<row r="${row + 1}">${values.map((value, col) => cell(value, `${columnName(col)}${row + 1}`, row === 0)).join("")}</row>`,
  );
  // Wide enough for the title and the first rows, never a whole screen
  const widths = sheet.columns.map((title, col) => {
    const longest = Math.max(
      title.length + 2,
      ...sheet.rows.slice(0, 200).map((values) => String(values[col] ?? "").length),
    );
    return Math.min(Math.max(longest + 2, 8), 60);
  });
  const cols = widths
    .map(
      (width, col) => `<col min="${col + 1}" max="${col + 1}" width="${width}" customWidth="1"/>`,
    )
    .join("");
  const last = `${columnName(Math.max(sheet.columns.length - 1, 0))}${sheet.rows.length + 1}`;
  const frozen =
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>';
  const filter = sheet.columns.length > 0 ? `<autoFilter ref="A1:${last}"/>` : "";

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${frozen}${cols ? `<cols>${cols}</cols>` : ""}<sheetData>${rows.join("")}</sheetData>${filter}</worksheet>`;
}

// Titles bold over the brand colour, amounts with thousands, dates as dates
const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<numFmts count="3"><numFmt numFmtId="164" formatCode="#,##0.00"/><numFmt numFmtId="165" formatCode="yyyy-mm-dd"/><numFmt numFmtId="166" formatCode="yyyy-mm-dd hh:mm"/></numFmts>' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>' +
  '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF5B4FD6"/><bgColor indexed="64"/></patternFill></fill></fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>' +
  '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';

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
  const names = sheetNames(sheets);
  const file = (path: string, content: string) => ({ path, data: Buffer.from(content, "utf8") });
  const head = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

  return zip([
    file(
      "[Content_Types].xml",
      `${head}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}</Types>`,
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
      `${head}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    ),
    file("xl/styles.xml", STYLES),
    ...sheets.map((sheet, i) => file(`xl/worksheets/sheet${i + 1}.xml`, worksheet(sheet))),
  ]);
}

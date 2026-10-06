import { PDFDocument } from "pdf-lib";

// The most pages the CLI reads of a PDF in one go; a longer file it reads only by page ranges,
// which needs a renderer installed on the server
export const PAGES_PER_READ = 10;

/**
 * Opens a PDF to count and split its pages; an encrypted or broken file cannot be read
 *
 * @param   pdf  File
 *
 * @return  The document, or null when it cannot be opened
 */
export async function openPdf(pdf: Buffer): Promise<PDFDocument | null> {
  try {
    const document = await PDFDocument.load(pdf, { updateMetadata: false });
    // A damaged file can open with no pages at all, which leaves nothing to read
    return document.getPageCount() > 0 ? document : null;
  } catch {
    return null;
  }
}

/**
 * Cuts some pages out of a PDF into a file of their own, so the model reads them whole
 *
 * @param   source  Whole document
 * @param   from    First page, counted from 1
 * @param   to      Last page
 *
 * @return  The file with those pages
 */
export async function pagesOf(source: PDFDocument, from: number, to: number): Promise<Buffer> {
  const part = await PDFDocument.create();
  const indices = Array.from({ length: to - from + 1 }, (_, offset) => from - 1 + offset);
  for (const page of await part.copyPages(source, indices)) {
    part.addPage(page);
  }

  return Buffer.from(await part.save());
}

/**
 * Splits the first pages of a PDF into files the CLI reads whole, each with the range it holds
 *
 * @param   pdf       File
 * @param   maxPages  Pages read at most; the rest are left out
 *
 * @return  The parts in order, or the file as it is when it is short or cannot be opened, and how
 *          many pages the file has
 */
export async function splitPdf(
  pdf: Buffer,
  maxPages: number,
): Promise<{ parts: Array<{ file: Buffer; from: number; to: number }>; pages: number }> {
  const source = await openPdf(pdf);
  const pages = source?.getPageCount() ?? 0;
  if (!source || pages <= PAGES_PER_READ) {
    return { parts: [{ file: pdf, from: 1, to: Math.max(pages, 1) }], pages };
  }

  const last = Math.min(pages, maxPages);
  const parts: Array<{ file: Buffer; from: number; to: number }> = [];
  for (let from = 1; from <= last; from += PAGES_PER_READ) {
    const to = Math.min(from + PAGES_PER_READ - 1, last);
    parts.push({ file: await pagesOf(source, from, to), from, to });
  }

  return { parts, pages };
}

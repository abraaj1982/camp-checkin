import { dirname, join } from "node:path";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import mammoth from "mammoth";
import type { SupportedFileType } from "@recruitment-platform/shared-types";

export interface ParsedDocument {
  text: string;
  // One entry per PDF page for page-level source references
  // (Evidence.sourcePage in Phase 4); null for DOCX, which has no fixed
  // pagination to anchor a page number to.
  pageTexts: string[] | null;
}

// Points pdf.js at its own bundled standard font metrics so it doesn't warn
// on every parse about a missing standardFontDataUrl — cosmetic only, text
// extraction works without it, but a clean Section-40-style error surface
// shouldn't include noise on the happy path.
const standardFontDataUrl = `${join(dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts")}/`;

export async function parseDocument(buffer: Buffer, fileType: SupportedFileType): Promise<ParsedDocument> {
  if (fileType === "pdf") return parsePdf(buffer);
  return parseDocx(buffer);
}

async function parsePdf(buffer: Buffer): Promise<ParsedDocument> {
  const pdf = await getDocument({
    data: new Uint8Array(buffer),
    standardFontDataUrl,
    useSystemFonts: true,
  }).promise;

  const pageTexts: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => ("str" in item ? item.str : "")).join(" ");
    pageTexts.push(pageText);
  }

  return { text: pageTexts.join("\n\n"), pageTexts };
}

async function parseDocx(buffer: Buffer): Promise<ParsedDocument> {
  const result = await mammoth.extractRawText({ buffer });
  return { text: result.value, pageTexts: null };
}

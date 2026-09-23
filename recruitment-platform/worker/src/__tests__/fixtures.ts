import PDFDocument from "pdfkit";
import { Document, Packer, Paragraph } from "docx";

/** Builds a real, parseable PDF with the given text — for parser tests. */
export async function buildTestPdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const chunks: Buffer[] = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.fontSize(12).text(text);
    doc.end();
  });
}

/** Builds a real, parseable DOCX with the given paragraphs — for parser tests. */
export async function buildTestDocx(paragraphs: string[]): Promise<Buffer> {
  const doc = new Document({
    sections: [{ children: paragraphs.map((text) => new Paragraph(text)) }],
  });
  return Packer.toBuffer(doc);
}

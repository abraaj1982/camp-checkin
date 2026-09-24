import PDFDocument from "pdfkit";

/**
 * Builds a real, parseable PDF with the given text — needed for the
 * candidate-match-reviews tests, which exercise the actual deterministic
 * parse -> identity-extraction path (unlike the plain candidate-upload
 * tests, which only need magic-number-valid bytes). Mirrors
 * worker/src/__tests__/fixtures.ts's buildTestPdf exactly.
 */
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

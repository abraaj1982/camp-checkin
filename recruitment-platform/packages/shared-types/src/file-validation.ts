/**
 * Deterministic upload validation (architecture doc, Section: Document
 * Processing Pipeline — "Formats (V1): PDF and DOCX with a text layer").
 * Pure function: takes what the upload route already has in hand
 * (filename, declared mimetype, byte size, and the first bytes for a magic-
 * number check) and decides accept/reject — no I/O, so it's unit-testable
 * without a real upload.
 */
export type SupportedFileType = "pdf" | "docx";

export interface FileValidationInput {
  filename: string;
  mimetype: string;
  sizeBytes: number;
  headerBytes: Buffer;
}

export interface FileValidationResult {
  ok: boolean;
  fileType?: SupportedFileType;
  error?: string;
}

const MAX_SIZE_BYTES = 15 * 1024 * 1024; // 15MB — a CV is text, not a media file
const PDF_MAGIC = Buffer.from("%PDF");
// DOCX is a zip (PK\x03\x04); this alone doesn't prove it's a .docx rather
// than some other zip, but combined with the extension it's a reasonable
// V1 check — full OOXML validation is unnecessary for a text-extraction step.
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

export function validateUpload(input: FileValidationInput): FileValidationResult {
  if (input.sizeBytes === 0) {
    return { ok: false, error: "empty_file" };
  }
  if (input.sizeBytes > MAX_SIZE_BYTES) {
    return { ok: false, error: "file_too_large" };
  }

  const extension = input.filename.split(".").pop()?.toLowerCase();
  const isPdfExtension = extension === "pdf";
  const isDocxExtension = extension === "docx";

  if (!isPdfExtension && !isDocxExtension) {
    return { ok: false, error: "unsupported_file_type" };
  }

  if (isPdfExtension) {
    if (!input.headerBytes.subarray(0, 4).equals(PDF_MAGIC)) {
      return { ok: false, error: "corrupted_or_mislabeled_pdf" };
    }
    return { ok: true, fileType: "pdf" };
  }

  // isDocxExtension
  if (!input.headerBytes.subarray(0, 4).equals(ZIP_MAGIC)) {
    return { ok: false, error: "corrupted_or_mislabeled_docx" };
  }
  return { ok: true, fileType: "docx" };
}

/**
 * A near-empty text extraction from an otherwise valid PDF/DOCX means the
 * document is image-only (scanned) — flagged FAILED_NEEDS_OCR rather than
 * silently processed with nothing to extract (architecture doc, Section:
 * Document Processing Pipeline). Deliberately not "zero characters": a
 * cover page or a mostly-image resume can still yield a handful of stray
 * characters that aren't usable text.
 */
const MIN_USABLE_TEXT_LENGTH = 50;

export function needsOcr(extractedText: string): boolean {
  return extractedText.trim().length < MIN_USABLE_TEXT_LENGTH;
}

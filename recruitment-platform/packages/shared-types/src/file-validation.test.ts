import { describe, expect, it } from "vitest";
import { needsOcr, validateUpload } from "./file-validation.js";

const PDF_HEADER = Buffer.from("%PDF-1.7\n...");
const ZIP_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
const RANDOM_HEADER = Buffer.from("not a real document");

describe("validateUpload", () => {
  it("accepts a valid PDF", () => {
    const result = validateUpload({
      filename: "resume.pdf",
      mimetype: "application/pdf",
      sizeBytes: 1024,
      headerBytes: PDF_HEADER,
    });
    expect(result).toEqual({ ok: true, fileType: "pdf" });
  });

  it("accepts a valid DOCX", () => {
    const result = validateUpload({
      filename: "resume.docx",
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 2048,
      headerBytes: ZIP_HEADER,
    });
    expect(result).toEqual({ ok: true, fileType: "docx" });
  });

  it("rejects an unsupported extension", () => {
    const result = validateUpload({
      filename: "resume.txt",
      mimetype: "text/plain",
      sizeBytes: 100,
      headerBytes: RANDOM_HEADER,
    });
    expect(result).toEqual({ ok: false, error: "unsupported_file_type" });
  });

  it("rejects a .pdf whose bytes are not actually a PDF (mislabeled/corrupted)", () => {
    const result = validateUpload({
      filename: "resume.pdf",
      mimetype: "application/pdf",
      sizeBytes: 100,
      headerBytes: RANDOM_HEADER,
    });
    expect(result).toEqual({ ok: false, error: "corrupted_or_mislabeled_pdf" });
  });

  it("rejects a .docx whose bytes are not a zip (mislabeled/corrupted)", () => {
    const result = validateUpload({
      filename: "resume.docx",
      mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      sizeBytes: 100,
      headerBytes: RANDOM_HEADER,
    });
    expect(result).toEqual({ ok: false, error: "corrupted_or_mislabeled_docx" });
  });

  it("rejects an empty file", () => {
    const result = validateUpload({
      filename: "resume.pdf",
      mimetype: "application/pdf",
      sizeBytes: 0,
      headerBytes: Buffer.alloc(0),
    });
    expect(result).toEqual({ ok: false, error: "empty_file" });
  });

  it("rejects a file over the size limit", () => {
    const result = validateUpload({
      filename: "resume.pdf",
      mimetype: "application/pdf",
      sizeBytes: 20 * 1024 * 1024,
      headerBytes: PDF_HEADER,
    });
    expect(result).toEqual({ ok: false, error: "file_too_large" });
  });
});

describe("needsOcr", () => {
  it("flags near-empty extracted text as needing OCR", () => {
    expect(needsOcr("   \n  ")).toBe(true);
    expect(needsOcr("Page 1")).toBe(true);
  });

  it("does not flag a normal amount of extracted text", () => {
    expect(
      needsOcr(
        "Jane Doe — Senior HR Manager. 10 years of experience in employee relations, " +
          "grievance handling, and disciplinary investigations across multiple regions.",
      ),
    ).toBe(false);
  });
});

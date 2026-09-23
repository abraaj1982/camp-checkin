import type { ProcessCandidateDocumentJobData } from "./queue.js";

/**
 * Document/CV processing pipeline (architecture doc, Section: Document
 * Processing Pipeline). Phase 1 (Foundation) delivers the queue mechanics
 * and per-candidate status tracking around this function; the pipeline body
 * — PDF/DOCX text extraction, then the Resume Intelligence / Requirement
 * Evidence Analysis / Career Consistency AI calls via AiGateway — is Phase 3
 * scope (Document & CV Engine) and Phase 4 (Recruitment Intelligence).
 *
 * This throws rather than pretending to succeed, per the "do not fake
 * functionality" rule (master instruction Section 49): a candidate document
 * enqueued today correctly lands in FAILED_RETRY with this reason, instead
 * of a fabricated COMPLETED status with no real extraction behind it.
 */
export async function runDocumentProcessingPipeline(
  _data: ProcessCandidateDocumentJobData,
): Promise<void> {
  throw new Error(
    "Document processing pipeline not yet implemented — scheduled for Phase 3 (Document & CV Engine) / Phase 4 (Recruitment Intelligence).",
  );
}

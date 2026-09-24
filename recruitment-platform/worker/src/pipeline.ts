import { prisma, recordAudit } from "@recruitment-platform/db";
import type { ObjectStorage } from "@recruitment-platform/storage";
import { AiGateway, AiValidationError } from "@recruitment-platform/ai-gateway";
import { needsOcr } from "@recruitment-platform/shared-types";
import type { ProcessCandidateDocumentJobData } from "@recruitment-platform/queue";
import { parseDocument } from "./parsing.js";
import { runRequirementEvidenceAnalysis } from "./requirement-evidence-analysis.js";
import { runCareerConsistencyAnalysis } from "./career-consistency-analysis.js";
import { startProcessingRun, failProcessingRun, completeProcessingRun } from "./processing-run.js";

/**
 * Document/CV processing pipeline (architecture doc, Section: Document
 * Processing Pipeline): fetch original -> parse -> normalize -> Resume
 * Intelligence via the AI Gateway -> persist normalized profile -> preserve
 * extracted text/pages on the CandidateDocument itself for Phase 4 to cite
 * without re-parsing. Terminal states (COMPLETED, and the OCR case) are set
 * here, not by the caller — see worker/src/index.ts, which only sets
 * PROCESSING before this runs and FAILED_RETRY if this throws.
 */
export async function runDocumentProcessingPipeline(
  data: ProcessCandidateDocumentJobData,
  deps: { storage: ObjectStorage; gateway: AiGateway },
): Promise<void> {
  const document = await prisma.candidateDocument.findUniqueOrThrow({
    where: { id: data.candidateDocumentId },
  });

  // Phase 4A retry design: one ProcessingRun per execution of this whole
  // pipeline. startProcessingRun refuses (throws) if a run is already
  // RUNNING for this document rather than invalidating it — see
  // processing-run.ts docs for the concurrency invariant. A thrown
  // ProcessingRunAlreadyActiveError propagates like any other pipeline
  // error: worker/src/index.ts's catch marks the document FAILED_RETRY.
  const run = await startProcessingRun(document.id);

  const originalBytes = await deps.storage.getObject(document.storageKey);
  const fileType = document.fileType === "pdf" ? "pdf" : "docx";
  const parsed = await parseDocument(originalBytes, fileType);

  if (needsOcr(parsed.text)) {
    await prisma.candidateDocument.update({
      where: { id: document.id },
      data: {
        status: "FAILED_NEEDS_OCR",
        failureReason: "Extracted text too short — document appears to be scanned/image-only.",
        extractedText: parsed.text,
        extractedPageTexts: parsed.pageTexts ?? undefined,
        parsedAt: new Date(),
      },
    });
    await failProcessingRun(run.id);
    await recordAudit({
      actorId: null,
      action: "CANDIDATE_DOCUMENT_NEEDS_OCR",
      entityType: "CandidateDocument",
      entityId: document.id,
      after: { status: "FAILED_NEEDS_OCR" },
    });
    return; // terminal, not a retryable failure — never throw for this case
  }

  let extraction;
  try {
    extraction = await deps.gateway.runTask({
      taskType: "RESUME_INTELLIGENCE",
      systemPrompt:
        "Extract a normalized candidate profile from this resume/CV text: work experience entries " +
        "(employer, title, start/end dates, documented responsibilities, and a functional-area tag " +
        "per entry such as 'Employee Relations' or 'Payroll'), education, skills, certifications, and " +
        "languages. Only extract what is explicitly documented in the text — never infer a " +
        "responsibility, date, or credential that is not stated. Use null for dates that are not given.",
      userPrompt: parsed.text,
      inputRef: `candidateDocument:${document.id}`,
    });
  } catch (err) {
    await failProcessingRun(run.id);
    if (err instanceof AiValidationError) {
      await recordAudit({
        actorId: null,
        action: "CANDIDATE_DOCUMENT_AI_EXTRACTION_FAILED",
        entityType: "CandidateDocument",
        entityId: document.id,
        after: { taskType: err.taskType },
      });
    }
    throw err; // retryable — caller marks FAILED_RETRY
  }

  await prisma.$transaction(async (tx) => {
    await tx.candidateExperience.deleteMany({ where: { candidateId: data.candidateId, documentId: document.id } });
    await tx.candidateEducation.deleteMany({ where: { candidateId: data.candidateId } });
    await tx.candidateSkill.deleteMany({ where: { candidateId: data.candidateId } });
    await tx.candidateCertification.deleteMany({ where: { candidateId: data.candidateId } });
    await tx.candidateLanguage.deleteMany({ where: { candidateId: data.candidateId } });

    for (const exp of extraction.experiences) {
      await tx.candidateExperience.create({
        data: {
          candidateId: data.candidateId,
          documentId: document.id,
          employer: exp.employer,
          title: exp.title,
          startDate: exp.startDate ? new Date(exp.startDate) : null,
          endDate: exp.endDate ? new Date(exp.endDate) : null,
          isCurrent: exp.isCurrent,
          responsibilities: exp.responsibilities,
          functionalAreaTags: exp.functionalAreaTags,
          extractedConfidence: exp.extractedConfidence,
        },
      });
    }
    for (const edu of extraction.education) {
      await tx.candidateEducation.create({
        data: {
          candidateId: data.candidateId,
          institution: edu.institution,
          degree: edu.degree,
          field: edu.field,
          startDate: edu.startDate ? new Date(edu.startDate) : null,
          endDate: edu.endDate ? new Date(edu.endDate) : null,
        },
      });
    }
    for (const skill of extraction.skills) {
      await tx.candidateSkill.create({
        data: { candidateId: data.candidateId, skillName: skill.skillName, category: skill.category },
      });
    }
    for (const cert of extraction.certifications) {
      await tx.candidateCertification.create({
        data: {
          candidateId: data.candidateId,
          name: cert.name,
          issuer: cert.issuer,
          dateObtained: cert.dateObtained ? new Date(cert.dateObtained) : null,
        },
      });
    }
    for (const lang of extraction.languages) {
      await tx.candidateLanguage.create({
        data: { candidateId: data.candidateId, language: lang.language, proficiency: lang.proficiency },
      });
    }

    // NOT the terminal COMPLETED write (Decision 5, Phase 4A review) — this
    // pipeline now has two AI steps (Resume Intelligence, then Requirement
    // Evidence Analysis below); COMPLETED must mean "every step succeeded,"
    // not just "extraction succeeded." Status stays PROCESSING here; the
    // extracted-text/page fields are persisted now since they're already
    // final regardless of what evidence analysis does next.
    await tx.candidateDocument.update({
      where: { id: document.id },
      data: {
        failureReason: null,
        extractedText: parsed.text,
        extractedPageTexts: parsed.pageTexts ?? undefined,
        parsedAt: new Date(),
      },
    });
  });

  await recordAudit({
    actorId: null,
    action: "CANDIDATE_DOCUMENT_PROCESSED",
    entityType: "CandidateDocument",
    entityId: document.id,
    after: {
      experiences: extraction.experiences.length,
      education: extraction.education.length,
      skills: extraction.skills.length,
      certifications: extraction.certifications.length,
      languages: extraction.languages.length,
    },
  });

  // Career/Consistency Analysis (master instruction Section 16) — runs
  // immediately after Resume Intelligence's CandidateExperience rows are
  // persisted, and before Requirement Evidence Analysis (explicit
  // decision: this is a REQUIRED pipeline step, not an independent/optional
  // analysis — its failure fails the whole ProcessingRun exactly like any
  // other step failure, with no partial-success status).
  try {
    await runCareerConsistencyAnalysis(document, data, parsed.text, deps.gateway, run.id);
  } catch (err) {
    await failProcessingRun(run.id);
    throw err; // retryable — caller marks FAILED_RETRY
  }

  // Requirement Evidence Analysis (Phase 4A) runs in the same job,
  // immediately after Resume Intelligence — one call per candidate, not a
  // separate queue/job type (architecture doc's existing per-document job
  // model). A failure here throws, same as a Resume Intelligence failure —
  // the whole document goes FAILED_RETRY, and reprocessing re-extracts and
  // re-analyzes rather than trying to resume partway through. Every
  // Assessment it creates links to this run (run.id).
  try {
    await runRequirementEvidenceAnalysis(document, data, parsed.text, deps.gateway, run.id);
  } catch (err) {
    await failProcessingRun(run.id);
    throw err; // retryable — caller marks FAILED_RETRY
  }

  // The one and only COMPLETED write (Decision 5) — reached only once both
  // Resume Intelligence and Requirement Evidence Analysis have succeeded.
  // completeProcessingRun atomically marks this run COMPLETED and promotes
  // it to CandidateDocument.currentProcessingRunId in one transaction. If
  // either step above throws, this line never runs, and worker/src/index.ts's
  // catch sets FAILED_RETRY instead — the document is never left reading as
  // COMPLETED when part of the pipeline didn't finish, and
  // currentProcessingRunId never points at a run that didn't fully succeed.
  await completeProcessingRun(run.id, document.id);
}

import { prisma, recordAudit, type CandidateDocument } from "@recruitment-platform/db";
import { AiGateway, AiValidationError } from "@recruitment-platform/ai-gateway";
import type { ProcessCandidateDocumentJobData } from "@recruitment-platform/queue";

/**
 * Career/Consistency Analysis (master instruction Section 16) — runs
 * immediately after Resume Intelligence has persisted CandidateExperience
 * rows, and before Requirement Evidence Analysis, in the same job (one call
 * per candidate, same call-efficiency principle as every other Phase 4
 * task). Evaluates the candidate's OWN timeline for gaps, overlaps, unclear
 * chronology, etc. — never evidence for or against a specific requirement,
 * so it has no dependency on CandidateBatchRequirementVersion pins and runs
 * even for a document with no batch.
 *
 * AI produces findings + a narrative; candidateId/projectId/sourceDocumentId
 * are always application-assigned, never read from the AI response (the
 * schema has no fields for them to begin with). progressionNarrative is
 * intentionally NOT persisted anywhere in this implementation (explicit
 * decision, deferred) — it is validated as part of the AI response and then
 * discarded.
 *
 * This is a REQUIRED pipeline step, same as Resume Intelligence and
 * Requirement Evidence Analysis (explicit decision): a failure here throws,
 * and the caller (worker/src/pipeline.ts) fails the ProcessingRun exactly
 * like any other step failure — there is no partial-success status and no
 * separate "optional analysis" carve-out.
 *
 * CandidateConsistencyFinding deliberately has no processingRunId (matching
 * Evidence, and unlike Assessment) — this is an explicit, documented,
 * deferred architectural gap, not an oversight: a retry's findings are not
 * currently distinguishable from a prior run's findings except by
 * createdAt/aiInteractionId. Do not silently "fix" this with a schema
 * change; it needs its own decision.
 */
export async function runCareerConsistencyAnalysis(
  document: CandidateDocument,
  data: ProcessCandidateDocumentJobData,
  extractedText: string,
  gateway: AiGateway,
): Promise<void> {
  const experiences = await prisma.candidateExperience.findMany({
    where: { candidateId: data.candidateId },
    orderBy: { startDate: "asc" },
  });

  let output;
  try {
    output = await gateway.runTask({
      taskType: "CAREER_CONSISTENCY_ANALYSIS",
      systemPrompt:
        "Review this candidate's work-experience timeline for consistency issues: employment gaps, " +
        "overlapping dates, unclear chronology, responsibilities inconsistent with stated seniority, or " +
        "any other pattern worth a human looking at. Use neutral, factual language only — never draw a " +
        "conclusion about the candidate's integrity, honesty, reliability, or character, and never state a " +
        "hiring, rejection, suitability, or overall recommendation. A finding based on a direct quote from " +
        "the resume text must cite its page and the exact quote; a finding derived purely from comparing " +
        "the given dates (e.g. a gap between two employers) has no single quote to cite and must leave " +
        "sourcePage and evidenceText null rather than fabricating one. Also provide a short overall " +
        "progression narrative summarizing the timeline.",
      userPrompt: JSON.stringify({
        resumeText: extractedText,
        experiences: experiences.map((exp) => ({
          employer: exp.employer,
          title: exp.title,
          startDate: exp.startDate,
          endDate: exp.endDate,
          isCurrent: exp.isCurrent,
        })),
      }),
      inputRef: `candidateDocument:${document.id}:consistency`,
    });
  } catch (err) {
    if (err instanceof AiValidationError) {
      await recordAudit({
        actorId: null,
        action: "CANDIDATE_CONSISTENCY_ANALYSIS_AI_FAILED",
        entityType: "CandidateDocument",
        entityId: document.id,
        after: { taskType: err.taskType },
      });
    }
    throw err; // retryable — worker/src/pipeline.ts fails the ProcessingRun, caller marks FAILED_RETRY
  }

  // The AiInteraction row the gateway just wrote — read back (not returned
  // by runTask itself, to avoid changing that shared contract), same
  // pattern as requirement-evidence-analysis.ts.
  const interaction = await prisma.aiInteraction.findFirst({
    where: { taskType: "CAREER_CONSISTENCY_ANALYSIS", inputRef: `candidateDocument:${document.id}:consistency` },
    orderBy: { createdAt: "desc" },
  });

  // output.progressionNarrative is intentionally read and then discarded —
  // not persisted anywhere (explicit decision, deferred). It has already
  // been validated as part of the AI response schema.
  await prisma.$transaction(async (tx) => {
    // Atomicity: either every finding from this call is persisted, or none
    // are — a failed/partial write must never leave a misleading subset of
    // findings on the candidate. No finding is ever deleted or updated by a
    // retry (matching Evidence's immutability); a retry simply creates
    // another full set via another call to this function.
    for (const finding of output.findings) {
      await tx.candidateConsistencyFinding.create({
        data: {
          candidateId: data.candidateId,
          projectId: data.projectId,
          findingType: finding.findingType,
          severity: finding.severity,
          description: finding.description,
          sourceDocumentId: document.id,
          sourcePage: finding.sourcePage,
          evidenceText: finding.evidenceText,
          confidence: finding.confidence,
          aiInteractionId: interaction?.id,
        },
      });
    }
  });

  await recordAudit({
    actorId: null,
    action: "CANDIDATE_CONSISTENCY_ANALYZED",
    entityType: "CandidateDocument",
    entityId: document.id,
    after: { findingsCount: output.findings.length },
  });
}

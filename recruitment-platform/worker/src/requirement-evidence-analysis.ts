import { prisma, recordAudit, type CandidateDocument } from "@recruitment-platform/db";
import { AiGateway, AiValidationError } from "@recruitment-platform/ai-gateway";
import { computeAssessmentStatus } from "@recruitment-platform/shared-types";
import type { ProcessCandidateDocumentJobData } from "@recruitment-platform/queue";

/**
 * Requirement Evidence Analysis (Phase 4A) — runs immediately after Resume
 * Intelligence succeeds, in the same job (architecture doc: one call per
 * candidate, not one call per requirement). Uses ONLY the requirement
 * versions pinned to this document's upload batch
 * (CandidateBatchRequirementVersion, Phase 4 foundation Decision 3) — never
 * re-queries "the current requirement," so this stays reproducible even if
 * HR edits the requirement afterward.
 *
 * AI proposes evidence candidates; computeAssessmentStatus
 * (packages/shared-types) — deterministic, application-owned — decides the
 * Assessment's per-requirement status. The AI output schema has no status
 * field to assign one through even if it tried. computedScoreContribution
 * is deliberately left unset — no approved scoring formula exists yet.
 *
 * Each call runs under a caller-supplied ProcessingRun (processingRunId) —
 * Phase 4A retry design. No Assessment or Evidence row is ever deleted or
 * updated by a retry; every Assessment created here links to the run that
 * produced it, and at most one Assessment per (processingRunId,
 * requirementId) is created (DB-enforced unique constraint, backstopped by
 * in-app dedup of duplicate requirementIds within one AI response).
 */
export async function runRequirementEvidenceAnalysis(
  document: CandidateDocument,
  data: ProcessCandidateDocumentJobData,
  extractedText: string,
  gateway: AiGateway,
  processingRunId: string,
): Promise<void> {
  if (!document.batchId) {
    // No batch (e.g. a document created outside the normal upload route, as
    // some Phase 3 tests do directly via Prisma) — nothing pinned to
    // evaluate against. Not an error: a candidate can be extracted without
    // yet being assessed against any requirement set.
    return;
  }

  const pins = await prisma.candidateBatchRequirementVersion.findMany({
    where: { batchId: document.batchId },
    include: { requirementVersion: true },
  });
  if (pins.length === 0) return; // no approved requirements were pinned for this batch

  let output;
  try {
    output = await gateway.runTask({
      taskType: "REQUIREMENT_EVIDENCE_ANALYSIS",
      systemPrompt:
        "For each job requirement below, identify evidence for it in the candidate's resume text. " +
        "Return one or more evidence candidates per requirement: SUPPORTING candidates are quotes that " +
        "genuinely support the requirement; CONSIDERED_REJECTED candidates are quotes you considered but " +
        "judged too weak, generic, or irrelevant to support it. If nothing in the text supports a " +
        "requirement, return a single candidate with evidenceStrength NOT_FOUND, evidenceType MISSING, " +
        "null evidenceText and sourcePage, and a reasoning explaining what was and wasn't found — never " +
        "omit a requirement, and never state as fact that the candidate lacks something merely because " +
        "it isn't mentioned. Every evidence candidate must be classified with a strength and confidence " +
        "and a short reasoning; you identify and classify evidence only — you do not decide whether the " +
        "candidate meets the requirement.",
      userPrompt: JSON.stringify({
        resumeText: extractedText,
        requirements: pins.map((pin) => ({
          requirementId: pin.requirementId,
          description: pin.requirementVersion.description,
          mandatory: pin.requirementVersion.mandatory,
          evidenceCriteria: pin.requirementVersion.evidenceCriteriaSnapshot,
        })),
      }),
      inputRef: `candidateDocument:${document.id}:evidence`,
    });
  } catch (err) {
    if (err instanceof AiValidationError) {
      await recordAudit({
        actorId: null,
        action: "CANDIDATE_EVIDENCE_ANALYSIS_AI_FAILED",
        entityType: "CandidateDocument",
        entityId: document.id,
        after: { taskType: err.taskType },
      });
    }
    throw err; // retryable — worker/src/index.ts marks the document FAILED_RETRY
  }

  // The AiInteraction row the gateway just wrote — read back (not returned
  // by runTask itself, to avoid changing that shared contract) so Evidence
  // rows can cite which model/interaction produced them.
  const interaction = await prisma.aiInteraction.findFirst({
    where: { taskType: "REQUIREMENT_EVIDENCE_ANALYSIS", inputRef: `candidateDocument:${document.id}:evidence` },
    orderBy: { createdAt: "desc" },
  });

  const requirementVersionByRequirementId = new Map(pins.map((pin) => [pin.requirementId, pin]));

  // Defensive in-app dedup: the AI could (incorrectly) return the same
  // requirementId twice in one response. The DB now enforces at most one
  // Assessment per (processingRunId, requirementId) via a unique
  // constraint — rather than let a rare AI quirk fail the whole
  // transaction, drop later duplicates here and keep the first occurrence.
  const seenRequirementIds = new Set<string>();
  const dedupedItems = output.items.filter((item) => {
    if (seenRequirementIds.has(item.requirementId)) return false;
    seenRequirementIds.add(item.requirementId);
    return true;
  });

  await prisma.$transaction(async (tx) => {
    // No Assessment or Evidence is ever deleted here (Phase 4A retry
    // design) — each execution of this function runs under its own
    // ProcessingRun, and every Assessment created below links to it via
    // processingRunId. Historical Assessment/Evidence rows from earlier
    // runs are left completely untouched.
    for (const item of dedupedItems) {
      const pin = requirementVersionByRequirementId.get(item.requirementId);
      if (!pin) continue; // AI referenced a requirement outside what it was given — ignore, never trust unprompted ids

      // Defense in depth beyond the zod schema (architecture doc: "do not
      // persist unsupported AI evidence without a source reference when
      // the source is expected to exist") — a candidate claiming any
      // strength other than NOT_FOUND with no quote at all is not
      // persisted as claimed evidence; it's downgraded to NOT_FOUND so the
      // deterministic status calc treats it as absent rather than trusting
      // an unsupported assertion.
      const sanitizedCandidates = item.evidenceCandidates.map((c) =>
        c.evidenceStrength !== "NOT_FOUND" && !c.evidenceText
          ? { ...c, evidenceStrength: "NOT_FOUND" as const, evidenceType: "MISSING" as const }
          : c,
      );

      const createdEvidence: { id: string; role: (typeof sanitizedCandidates)[number]["role"]; rationale: string }[] =
        [];
      for (const candidate of sanitizedCandidates) {
        const evidence = await tx.evidence.create({
          data: {
            requirementId: item.requirementId,
            candidateId: data.candidateId,
            projectId: data.projectId,
            sourceDocumentId: document.id,
            sourcePage: candidate.sourcePage,
            evidenceText: candidate.evidenceText,
            evidenceType: candidate.evidenceType,
            evidenceStrength: candidate.evidenceStrength,
            confidence: candidate.confidence,
            aiModel: interaction?.model,
            aiInteractionId: interaction?.id,
          },
        });
        createdEvidence.push({ id: evidence.id, role: candidate.role, rationale: candidate.reasoning });
      }

      const supportingStrengths = sanitizedCandidates
        .filter((c) => c.role === "SUPPORTING")
        .map((c) => c.evidenceStrength);
      const status = computeAssessmentStatus(supportingStrengths, pin.requirementVersion.mandatory);
      const supportingCount = supportingStrengths.length;
      const rejectedCount = sanitizedCandidates.length - supportingCount;

      await tx.assessment.create({
        data: {
          candidateId: data.candidateId,
          projectId: data.projectId,
          requirementId: item.requirementId,
          requirementVersionId: pin.requirementVersionId,
          processingRunId,
          aiAssessmentSummary: `${supportingCount} supporting, ${rejectedCount} considered-and-rejected evidence item(s) identified.`,
          status,
          // computedScoreContribution intentionally left unset (null) — no
          // approved deterministic scoring formula exists yet (Decision 2,
          // Phase 4A review). Do not infer one here.
          aiInteractionId: interaction?.id,
          evidenceLinks: {
            create: createdEvidence.map((e) => ({
              evidenceId: e.id,
              role: e.role,
              rationale: e.rationale,
            })),
          },
        },
      });
    }
  });

  await recordAudit({
    actorId: null,
    action: "CANDIDATE_EVIDENCE_ANALYZED",
    entityType: "CandidateDocument",
    entityId: document.id,
    after: { requirementsEvaluated: dedupedItems.length },
  });
}

import { prisma } from "@recruitment-platform/db";
import {
  computeCandidateScore,
  type CandidateScoreResult,
  type CandidateScoreBlocked,
  type ScoringRequirementInput,
} from "@recruitment-platform/shared-types";
import { resolveEligibleAssessments } from "./eligibility.js";

export type ComputeLiveCandidateScoreResult =
  | CandidateScoreResult
  | CandidateScoreBlocked
  | { computable: false; reason: "PII_PURGED" };

/**
 * V1 Live Candidate Scoring (Score Evidence Eligibility decision paper,
 * Checkpoint 3, Decisions 1-12, all ratified). Orchestrates:
 *
 *   CandidateProjectAuthority (read inside resolveEligibleAssessments,
 *   unchanged) -> Score-Evidence-Eligible Assessments -> Requirement
 *   Evaluation State -> Live Score.
 *
 * Live-only (Decision 11): no persistence, no snapshot, no historical
 * score, no scoring-rule version. Re-run on every call.
 *
 * PII-purge check (Decision 10) happens HERE, before eligibility is even
 * consulted — a scoring-policy gate, never added to
 * resolveEligibleAssessments or CandidateProjectAuthority itself.
 */
export async function computeLiveCandidateScore(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0] | typeof prisma,
  candidateId: string,
  projectId: string,
): Promise<ComputeLiveCandidateScoreResult> {
  const candidate = await tx.candidate.findUnique({
    where: { id: candidateId },
    select: { piiPurgedAt: true },
  });
  if (candidate?.piiPurgedAt) {
    return { computable: false, reason: "PII_PURGED" };
  }

  // Live requirement set (Decision 5, unchanged, ratified): all non-ARCHIVED
  // requirements for the project — a never-approved requirement
  // (currentVersionNumber === 0) remains a member of this set; it is
  // flagged via a null weight below, never excluded here.
  const requirements = await tx.jobRequirement.findMany({
    where: { projectId, status: { not: "ARCHIVED" } },
    select: { id: true, currentVersionNumber: true },
  });

  const eligibleAssessments = await resolveEligibleAssessments(tx, candidateId, projectId);
  const eligibleAssessmentsWithEvidence = await tx.assessment.findMany({
    where: { id: { in: eligibleAssessments.map((a) => a.id) } },
    select: {
      id: true,
      requirementId: true,
      requirementVersionId: true,
      requirementVersion: { select: { hrApprovedWeight: true } },
      evidenceLinks: { select: { role: true, evidence: { select: { evidenceStrength: true } } } },
    },
  });
  const assessmentByRequirementId = new Map(eligibleAssessmentsWithEvidence.map((a) => [a.requirementId, a]));

  // Resolve the current approved version's weight for requirements with no
  // eligible Assessment (UNASSESSED) but a known approved version
  // (currentVersionNumber > 0) — current version is used ONLY in the
  // absence of an Assessment to pin to; an eligible Assessment's own
  // pinned requirementVersionId always takes precedence (Decision 4/5,
  // this checkpoint's correction) and is never overridden by the current
  // version merely because it is current.
  const currentVersionRequirementIds = requirements
    .filter((r) => r.currentVersionNumber > 0 && !assessmentByRequirementId.has(r.id))
    .map((r) => r.id);
  const currentVersions =
    currentVersionRequirementIds.length === 0
      ? []
      : await tx.jobRequirementVersion.findMany({
          where: { requirementId: { in: currentVersionRequirementIds } },
          select: { requirementId: true, versionNumber: true, hrApprovedWeight: true },
        });
  const requirementById = new Map(requirements.map((r) => [r.id, r]));
  const currentVersionWeightByRequirementId = new Map(
    currentVersions
      .filter((v) => v.versionNumber === requirementById.get(v.requirementId)?.currentVersionNumber)
      .map((v) => [v.requirementId, Number(v.hrApprovedWeight)]),
  );

  const scoringInputs: ScoringRequirementInput[] = requirements.map((requirement) => {
    const assessment = assessmentByRequirementId.get(requirement.id);

    if (assessment) {
      // Weight MUST come from the Assessment's own pinned requirementVersion
      // — never the requirement's current version merely because it is
      // current (ratified correction). A legacy eligible Assessment with
      // requirementVersionId === NULL has no resolvable weight: null,
      // never a fallback to the current version.
      const weight =
        assessment.requirementVersionId && assessment.requirementVersion
          ? Number(assessment.requirementVersion.hrApprovedWeight)
          : null;
      return {
        requirementId: requirement.id,
        weight,
        hasEligibleAssessment: true,
        evidence: assessment.evidenceLinks.map((link) => ({
          role: link.role,
          strength: link.evidence.evidenceStrength,
        })),
      };
    }

    // No eligible Assessment -> UNASSESSED. Weight resolved from the
    // requirement's current approved version if one exists
    // (currentVersionNumber > 0); otherwise null, i.e.
    // NOT_YET_APPROVED (currentVersionNumber === 0 — ratified: remains a
    // live requirement, but blocks score computation rather than being
    // silently excluded or treated as zero-weight).
    const weight = currentVersionWeightByRequirementId.get(requirement.id) ?? null;
    return {
      requirementId: requirement.id,
      weight,
      hasEligibleAssessment: false,
      evidence: [],
    };
  });

  return computeCandidateScore(scoringInputs);
}

/**
 * Deterministic Assessment status/score derivation (Phase 4A). The AI
 * (Requirement Evidence Analysis) identifies and classifies evidence; it
 * never assigns a final AssessmentStatus — there is no such field in
 * requirementEvidenceAnalysisOutputSchema (packages/shared-types/src/ai-tasks.ts)
 * for it to return one through. This module is the "application decides"
 * half of "AI proposes -> application decides" (Section 38 of the
 * architecture doc), using only fields that already existed in the schema
 * before Phase 4A: AssessmentStatus, EvidenceStrength, JobRequirement.mandatory,
 * JobRequirementVersion.hrApprovedWeight — no new scoring model invented.
 *
 * CONSIDERED_REJECTED evidence never influences the result — only
 * SUPPORTING evidence counts toward status or score, matching the
 * AssessmentEvidenceRole split established in the Phase 2 hardening pass.
 */
import type { EvidenceStrength } from "./ai-tasks.js";

export type AssessmentStatus =
  | "STRONG_EVIDENCE"
  | "REVIEW_REQUIRED"
  | "MANDATORY_GAP"
  | "INSUFFICIENT_EVIDENCE";

const STRENGTH_RANK: Record<EvidenceStrength, number> = {
  STRONG: 4,
  MODERATE: 3,
  PARTIAL: 2,
  WEAK: 1,
  CONTRADICTORY: 0,
  NOT_FOUND: 0,
};

const STRENGTH_SCORE: Record<EvidenceStrength, number> = {
  STRONG: 1,
  MODERATE: 0.75,
  PARTIAL: 0.5,
  WEAK: 0.25,
  CONTRADICTORY: 0,
  NOT_FOUND: 0,
};

/** The single strongest SUPPORTING-role strength for one requirement, or NOT_FOUND if there is none. */
export function strongestSupportingStrength(supportingStrengths: EvidenceStrength[]): EvidenceStrength {
  if (supportingStrengths.length === 0) return "NOT_FOUND";
  return supportingStrengths.reduce((best, current) =>
    STRENGTH_RANK[current] > STRENGTH_RANK[best] ? current : best,
  );
}

export function computeAssessmentStatus(
  supportingStrengths: EvidenceStrength[],
  mandatory: boolean,
): AssessmentStatus {
  const best = strongestSupportingStrength(supportingStrengths);
  if (best === "STRONG" || best === "MODERATE") return "STRONG_EVIDENCE";
  if (best === "PARTIAL" || best === "WEAK") return "REVIEW_REQUIRED";
  // best is NOT_FOUND or CONTRADICTORY
  return mandatory ? "MANDATORY_GAP" : "INSUFFICIENT_EVIDENCE";
}

/**
 * Fractional contribution of this one requirement toward an eventual
 * overall match figure — HR-approved weight scaled by how strong the best
 * supporting evidence is. Never computed or returned by the AI.
 */
export function computeScoreContribution(hrApprovedWeight: number, supportingStrengths: EvidenceStrength[]): number {
  const best = strongestSupportingStrength(supportingStrengths);
  return (hrApprovedWeight / 100) * STRENGTH_SCORE[best];
}

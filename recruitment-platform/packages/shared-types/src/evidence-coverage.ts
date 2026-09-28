/**
 * Phase 9 — Evidence Coverage (Model C, final decision). Deterministic,
 * pure, no DB or AI access — mirrors weighting.ts's own discipline
 * ("never delegated to the LLM").
 *
 * This is NOT a score. It never assigns a numeric value to any
 * EvidenceStrength category, and it never lets EvidenceConfidence affect
 * coverage or the covered/not-covered decision. A requirement is covered
 * only when it has at least one SUPPORTING item at STRONG or MODERATE
 * strength and is not contested; PARTIAL/WEAK/NOT_FOUND are not covered,
 * with no partial credit. Confidence surfaces only as a separate,
 * non-scoring review flag (LowConfidenceAssessment).
 */

export type EvidenceStrengthValue = "STRONG" | "MODERATE" | "PARTIAL" | "WEAK" | "NOT_FOUND" | "CONTRADICTORY";
export type EvidenceConfidenceValue = "HIGH" | "MEDIUM" | "LOW";
export type AssessmentEvidenceRoleValue = "SUPPORTING" | "CONSIDERED_REJECTED";

export interface CoverageEvidenceItem {
  role: AssessmentEvidenceRoleValue;
  strength: EvidenceStrengthValue;
  confidence: EvidenceConfidenceValue;
}

export interface CoverageRequirementInput {
  requirementId: string;
  mandatory: boolean;
  // Approved weight in effect when this requirement was assessed (the
  // pinned JobRequirementVersion's own hrApprovedWeight — immutable).
  // null when unavailable (e.g. no requirementVersion pinned) — excluded
  // from the numerator and from scoredWeight, but never from the fixed
  // 100-point denominator.
  weight: number | null;
  evidence: CoverageEvidenceItem[];
}

export interface RequirementCoverageResult {
  requirementId: string;
  covered: boolean;
  contested: boolean;
  mandatoryGap: boolean;
  lowConfidenceAssessment: boolean;
}

export interface CandidateCoverageResult {
  coveragePercentage: number;
  status: "COMPLETE" | "INCOMPLETE";
  scoredWeight: number;
  totalWeight: number;
  mandatoryGapCount: number;
  lowConfidenceCoveredCount: number;
  perRequirement: RequirementCoverageResult[];
}

const TOTAL_APPROVED_WEIGHT = 100;
const COMPLETE_TOLERANCE = 0.01;

/** Any evidence item (regardless of role) marked CONTRADICTORY contests the requirement. */
export function isContested(evidence: CoverageEvidenceItem[]): boolean {
  return evidence.some((item) => item.strength === "CONTRADICTORY");
}

/**
 * Covered iff at least one SUPPORTING item is STRONG or MODERATE and the
 * requirement is not contested. No numeric conversion, no averaging, no
 * "best evidence" magnitude — this is a set-membership test only.
 */
export function isCovered(evidence: CoverageEvidenceItem[]): boolean {
  if (isContested(evidence)) return false;
  return evidence.some((item) => item.role === "SUPPORTING" && (item.strength === "STRONG" || item.strength === "MODERATE"));
}

/**
 * Purely informational — never affects covered()/coverage. Only
 * meaningful when covered is true: flags that the qualifying evidence
 * itself was assessed at LOW confidence, prompting HR to check it.
 */
export function isLowConfidenceAssessment(evidence: CoverageEvidenceItem[]): boolean {
  if (!isCovered(evidence)) return false;
  return evidence.some(
    (item) =>
      item.role === "SUPPORTING" &&
      (item.strength === "STRONG" || item.strength === "MODERATE") &&
      item.confidence === "LOW",
  );
}

/** Mandatory requirement, not covered — a review/veto flag, never an additional numeric penalty. No severity scale. */
export function isMandatoryGap(mandatory: boolean, evidence: CoverageEvidenceItem[]): boolean {
  return mandatory && !isCovered(evidence);
}

export function evaluateRequirementCoverage(input: CoverageRequirementInput): RequirementCoverageResult {
  const covered = isCovered(input.evidence);
  return {
    requirementId: input.requirementId,
    covered,
    contested: isContested(input.evidence),
    mandatoryGap: isMandatoryGap(input.mandatory, input.evidence),
    lowConfidenceAssessment: isLowConfidenceAssessment(input.evidence),
  };
}

/**
 * Evidence Coverage % = weighted sum of covered requirements / the full
 * approved project weight (always 100, never renormalized to only-scored
 * requirements) — so a candidate can never reach 100% merely because some
 * requirements are missing or unassessed; that incompleteness is instead
 * surfaced via `status`/`scoredWeight`.
 */
export function computeCandidateCoverage(requirements: CoverageRequirementInput[]): CandidateCoverageResult {
  const perRequirement = requirements.map(evaluateRequirementCoverage);
  const resultById = new Map(perRequirement.map((r) => [r.requirementId, r]));

  let coveredWeight = 0;
  let scoredWeight = 0;
  for (const requirement of requirements) {
    if (requirement.weight === null) continue; // unavailable — excluded from numerator and scoredWeight, denominator unaffected
    scoredWeight += requirement.weight;
    if (resultById.get(requirement.requirementId)?.covered) coveredWeight += requirement.weight;
  }

  const status: "COMPLETE" | "INCOMPLETE" =
    Math.abs(scoredWeight - TOTAL_APPROVED_WEIGHT) <= COMPLETE_TOLERANCE ? "COMPLETE" : "INCOMPLETE";

  return {
    coveragePercentage: (coveredWeight / TOTAL_APPROVED_WEIGHT) * 100,
    status,
    scoredWeight,
    totalWeight: TOTAL_APPROVED_WEIGHT,
    mandatoryGapCount: perRequirement.filter((r) => r.mandatoryGap).length,
    lowConfidenceCoveredCount: perRequirement.filter((r) => r.lowConfidenceAssessment).length,
    perRequirement,
  };
}

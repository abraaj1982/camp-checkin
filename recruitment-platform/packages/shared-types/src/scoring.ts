/**
 * V1 Candidate Scoring (Score Evidence Eligibility decision paper,
 * Checkpoint 3, Decisions 1-12, all ratified). Pure, deterministic, no DB
 * or AI access — mirrors evidence-coverage.ts's own discipline.
 *
 * Deliberately NOT a reuse of evidence-coverage.ts: Evidence Coverage
 * remains a separate, broad-current-run HR-review signal and is never
 * consumed as a scoring input (ratified boundary). This module consumes
 * only Score-Evidence-Eligible Assessments, assembled by its caller via
 * resolveEligibleAssessments (apps/api/src/modules/assessments/eligibility.ts)
 * — this file has no knowledge of authority, eligibility, or Prisma at all.
 *
 * Deliberately does NOT reuse computeAssessmentStatus/strongestSupportingStrength
 * (AssessmentStatus is a review label, not the scoring Evaluation State —
 * Decision 1/6) and does NOT reuse computeScoreContribution/STRENGTH_SCORE
 * below (that formula was explicitly rejected; left in place as dead code,
 * never imported here).
 */

export type EvaluationState = "ESTABLISHED" | "PARTIAL" | "NOT_ESTABLISHED" | "CONTESTED" | "UNASSESSED";

export type ScoringEvidenceRole = "SUPPORTING" | "CONSIDERED_REJECTED";
export type ScoringEvidenceStrength = "STRONG" | "MODERATE" | "PARTIAL" | "WEAK" | "NOT_FOUND" | "CONTRADICTORY";

export interface ScoringEvidenceItem {
  role: ScoringEvidenceRole;
  strength: ScoringEvidenceStrength;
}

/**
 * weight: null means a resolvable, authoritative weight is NOT available for
 * this requirement (Decision: NOT_YET_APPROVED, or a legacy eligible
 * Assessment with no pinned requirementVersionId) — the caller must supply
 * `null` in both of those cases; this module never invents a fallback.
 */
export interface ScoringRequirementInput {
  requirementId: string;
  weight: number | null;
  hasEligibleAssessment: boolean;
  evidence: ScoringEvidenceItem[];
}

export interface RequirementScoreResult {
  requirementId: string;
  state: EvaluationState;
  weight: number;
  contribution: number;
}

export type CandidateScoreBlockReason = "LIVE_REQUIREMENT_NOT_YET_APPROVED";

export interface CandidateScoreBlocked {
  computable: false;
  reason: CandidateScoreBlockReason;
  requirementIds: string[];
}

export interface CandidateScoreResult {
  computable: true;
  score: number;
  numerator: number;
  denominator: number;
  perRequirement: RequirementScoreResult[];
}

/** Mapping 2 (ratified). CONTESTED = 0 is intentional: contradiction removes credit, never a negative penalty. */
const STATE_VALUE: Record<EvaluationState, number> = {
  ESTABLISHED: 1.0,
  PARTIAL: 0.5,
  NOT_ESTABLISHED: 0,
  CONTESTED: 0,
  UNASSESSED: 0,
};

/**
 * CONTRADICTORY is checked first and is role-agnostic (mirrors
 * isContested's existing precedent, re-derived independently here rather
 * than imported, per the ratified eligibility/scoring-state separation) —
 * it overrides even STRONG SUPPORTING evidence on the same requirement.
 * Only SUPPORTING-role evidence can establish ESTABLISHED/PARTIAL.
 */
export function deriveEvaluationState(
  hasEligibleAssessment: boolean,
  evidence: ScoringEvidenceItem[],
): EvaluationState {
  if (!hasEligibleAssessment) return "UNASSESSED";
  if (evidence.some((e) => e.strength === "CONTRADICTORY")) return "CONTESTED";
  const supporting = evidence.filter((e) => e.role === "SUPPORTING");
  if (supporting.some((e) => e.strength === "STRONG" || e.strength === "MODERATE")) return "ESTABLISHED";
  if (supporting.some((e) => e.strength === "PARTIAL" || e.strength === "WEAK")) return "PARTIAL";
  return "NOT_ESTABLISHED";
}

export function computeRequirementScore(input: ScoringRequirementInput): RequirementScoreResult {
  const state = deriveEvaluationState(input.hasEligibleAssessment, input.evidence);
  const weight = input.weight ?? 0;
  return {
    requirementId: input.requirementId,
    state,
    weight,
    contribution: weight * STATE_VALUE[state],
  };
}

/**
 * Fixed, non-renormalized denominator (Decision 7) — the full sum of live
 * requirement weights, always, regardless of each requirement's state.
 * If ANY requirement has weight === null (NOT_YET_APPROVED or a legacy
 * eligible Assessment with no pinned version), the score is not computed
 * at all — never partially scored over the remaining requirements, never
 * renormalized, never defaulted to zero-weight (Decision: ratified
 * LIVE_REQUIREMENT_NOT_YET_APPROVED block).
 */
export function computeCandidateScore(
  requirements: ScoringRequirementInput[],
): CandidateScoreResult | CandidateScoreBlocked {
  const unresolvedWeightRequirementIds = requirements.filter((r) => r.weight === null).map((r) => r.requirementId);
  if (unresolvedWeightRequirementIds.length > 0) {
    return { computable: false, reason: "LIVE_REQUIREMENT_NOT_YET_APPROVED", requirementIds: unresolvedWeightRequirementIds };
  }

  const perRequirement = requirements.map(computeRequirementScore);
  const denominator = perRequirement.reduce((sum, r) => sum + r.weight, 0);
  const numerator = perRequirement.reduce((sum, r) => sum + r.contribution, 0);

  return {
    computable: true,
    score: denominator > 0 ? (numerator / denominator) * 100 : 0,
    numerator,
    denominator,
    perRequirement,
  };
}

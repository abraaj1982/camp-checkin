/**
 * Deterministic weight-total validation (architecture doc Section 9 / Phase
 * 2 Section 6: "AI only proposes... the application remains responsible for
 * deterministic validation"). Never delegated to the LLM, never fuzzy.
 */
export interface WeightEntry {
  requirementId: string;
  weight: number;
}

export interface WeightValidationResult {
  valid: boolean;
  total: number;
}

const TOLERANCE = 0.01;

export function validateWeightTotal(weights: WeightEntry[]): WeightValidationResult {
  const total = weights.reduce((sum, w) => sum + w.weight, 0);
  return { valid: Math.abs(total - 100) <= TOLERANCE, total };
}

/**
 * A weight change requires an HR note only when the HR-entered value
 * diverges from what the AI suggested (Phase 2, Section 7: "Any
 * modification must require/allow an HR note") — accepting the AI's number
 * as-is needs no justification.
 */
export function weightChangeRequiresNote(
  aiSuggestedWeight: number | null,
  hrWeight: number,
): boolean {
  if (aiSuggestedWeight === null) return false;
  return Math.abs(aiSuggestedWeight - hrWeight) > TOLERANCE;
}

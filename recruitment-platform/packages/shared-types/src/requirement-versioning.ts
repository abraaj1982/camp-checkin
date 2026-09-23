/**
 * Pure snapshot builder for JobRequirementVersion (architecture doc Phase 2,
 * Section 10). Kept separate from the Prisma call so the "what goes into a
 * version snapshot" rule is unit-testable without a database, and so it
 * can't silently drift between the create-version code path and any future
 * one.
 */
export interface RequirementSnapshotSource {
  category: string;
  customCategoryLabel: string | null;
  description: string;
  mandatory: boolean;
  priority: string;
  aiInterpretationSummary: string | null;
  aiSuggestedWeight: number | null;
  criteria: string[]; // RequirementEvidenceCriterion.description, in order
}

export interface RequirementVersionSnapshot {
  versionNumber: number;
  category: string;
  customCategoryLabel: string | null;
  description: string;
  mandatory: boolean;
  priority: string;
  evidenceCriteriaSnapshot: string[];
  aiInterpretationSummary: string | null;
  aiSuggestedWeight: number | null;
  hrApprovedWeight: number;
}

/**
 * @param previousVersionNumber The requirement's currentVersionNumber before
 *   this approval (0 if never approved). The new snapshot is always
 *   previousVersionNumber + 1 — approval is the only thing that advances the
 *   version, never a plain edit (Section 10: edits move status to CHANGED,
 *   not a new version, until re-approved).
 */
export function buildRequirementVersionSnapshot(
  source: RequirementSnapshotSource,
  previousVersionNumber: number,
  hrApprovedWeight: number,
): RequirementVersionSnapshot {
  return {
    versionNumber: previousVersionNumber + 1,
    category: source.category,
    customCategoryLabel: source.customCategoryLabel,
    description: source.description,
    mandatory: source.mandatory,
    priority: source.priority,
    evidenceCriteriaSnapshot: [...source.criteria],
    aiInterpretationSummary: source.aiInterpretationSummary,
    aiSuggestedWeight: source.aiSuggestedWeight,
    hrApprovedWeight,
  };
}

/**
 * Editing an already-approved requirement must never silently overwrite the
 * version HR already approved (Section 10). This just states the rule as
 * code so it's testable: any edit to a requirement whose currentVersionNumber
 * > 0 moves it to CHANGED, never mutates the existing JobRequirementVersion
 * row, and requires a fresh approval (which will create version N+1) before
 * candidate analysis can use it again.
 */
export function statusAfterEdit(currentVersionNumber: number): "DRAFT" | "CHANGED" {
  return currentVersionNumber > 0 ? "CHANGED" : "DRAFT";
}

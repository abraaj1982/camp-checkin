import { describe, expect, it } from "vitest";
import {
  deriveEvaluationState,
  computeRequirementScore,
  computeCandidateScore,
  type ScoringEvidenceItem,
  type ScoringRequirementInput,
  type CandidateScoreResult,
  type CandidateScoreBlocked,
} from "./scoring.js";

function item(overrides: Partial<ScoringEvidenceItem> = {}): ScoringEvidenceItem {
  return { role: "SUPPORTING", strength: "STRONG", ...overrides };
}

function req(overrides: Partial<ScoringRequirementInput> = {}): ScoringRequirementInput {
  return { requirementId: "r1", weight: 50, hasEligibleAssessment: true, evidence: [], ...overrides };
}

describe("deriveEvaluationState", () => {
  it("no eligible Assessment -> UNASSESSED regardless of evidence", () => {
    expect(deriveEvaluationState(false, [item({ strength: "STRONG" })])).toBe("UNASSESSED");
    expect(deriveEvaluationState(false, [])).toBe("UNASSESSED");
  });

  it("STRONG supporting evidence -> ESTABLISHED", () => {
    expect(deriveEvaluationState(true, [item({ strength: "STRONG" })])).toBe("ESTABLISHED");
  });

  it("MODERATE supporting evidence -> ESTABLISHED", () => {
    expect(deriveEvaluationState(true, [item({ strength: "MODERATE" })])).toBe("ESTABLISHED");
  });

  it("PARTIAL supporting evidence -> PARTIAL", () => {
    expect(deriveEvaluationState(true, [item({ strength: "PARTIAL" })])).toBe("PARTIAL");
  });

  it("WEAK supporting evidence -> PARTIAL (merged with PARTIAL per ratified Decision 2)", () => {
    expect(deriveEvaluationState(true, [item({ strength: "WEAK" })])).toBe("PARTIAL");
  });

  it("NOT_FOUND evidence with an eligible Assessment -> NOT_ESTABLISHED", () => {
    expect(deriveEvaluationState(true, [item({ strength: "NOT_FOUND" })])).toBe("NOT_ESTABLISHED");
  });

  it("eligible Assessment with zero evidence items -> NOT_ESTABLISHED (not UNASSESSED)", () => {
    expect(deriveEvaluationState(true, [])).toBe("NOT_ESTABLISHED");
  });

  it("CONTRADICTORY evidence -> CONTESTED, overriding otherwise-STRONG supporting evidence on the same requirement", () => {
    const evidence = [item({ strength: "STRONG" }), item({ strength: "CONTRADICTORY" })];
    expect(deriveEvaluationState(true, evidence)).toBe("CONTESTED");
  });

  it("CONTRADICTORY is role-agnostic: a CONSIDERED_REJECTED CONTRADICTORY item still forces CONTESTED", () => {
    const evidence = [
      item({ role: "SUPPORTING", strength: "STRONG" }),
      item({ role: "CONSIDERED_REJECTED", strength: "CONTRADICTORY" }),
    ];
    expect(deriveEvaluationState(true, evidence)).toBe("CONTESTED");
  });

  it("CONSIDERED_REJECTED STRONG evidence alone does not establish the requirement", () => {
    const evidence = [item({ role: "CONSIDERED_REJECTED", strength: "STRONG" })];
    expect(deriveEvaluationState(true, evidence)).toBe("NOT_ESTABLISHED");
  });
});

describe("computeRequirementScore (Mapping 2, ratified)", () => {
  it("ESTABLISHED contributes full weight", () => {
    const result = computeRequirementScore(req({ weight: 50, evidence: [item({ strength: "STRONG" })] }));
    expect(result.state).toBe("ESTABLISHED");
    expect(result.contribution).toBe(50);
  });

  it("PARTIAL contributes half weight", () => {
    const result = computeRequirementScore(req({ weight: 50, evidence: [item({ strength: "PARTIAL" })] }));
    expect(result.state).toBe("PARTIAL");
    expect(result.contribution).toBe(25);
  });

  it("NOT_ESTABLISHED contributes zero", () => {
    const result = computeRequirementScore(req({ weight: 50, evidence: [item({ strength: "NOT_FOUND" })] }));
    expect(result.contribution).toBe(0);
  });

  it("CONTESTED contributes zero, not a negative penalty", () => {
    const result = computeRequirementScore(req({ weight: 50, evidence: [item({ strength: "CONTRADICTORY" })] }));
    expect(result.state).toBe("CONTESTED");
    expect(result.contribution).toBe(0);
  });

  it("UNASSESSED contributes zero", () => {
    const result = computeRequirementScore(req({ weight: 50, hasEligibleAssessment: false, evidence: [] }));
    expect(result.state).toBe("UNASSESSED");
    expect(result.contribution).toBe(0);
  });

  it("zero-weight requirement contributes zero regardless of state", () => {
    const result = computeRequirementScore(req({ weight: 0, evidence: [item({ strength: "STRONG" })] }));
    expect(result.state).toBe("ESTABLISHED");
    expect(result.contribution).toBe(0);
  });
});

describe("computeCandidateScore — fixed denominator (Decision 7, ratified)", () => {
  it("denominator is the full sum of live requirement weights, never renormalized", () => {
    const requirements = [
      req({ requirementId: "A", weight: 50, evidence: [item({ strength: "STRONG" })] }),
      req({ requirementId: "B", weight: 30, hasEligibleAssessment: true, evidence: [item({ strength: "NOT_FOUND" })] }),
      req({ requirementId: "C", weight: 20, hasEligibleAssessment: false, evidence: [] }),
    ];
    const result = computeCandidateScore(requirements) as CandidateScoreResult;
    expect(result.computable).toBe(true);
    expect(result.denominator).toBe(100);
    expect(result.numerator).toBe(50);
    expect(result.score).toBe(50);
  });

  it("multiple requirements with distinct weights and mixed states compute correct numerator/denominator/percentage", () => {
    const requirements = [
      req({ requirementId: "A", weight: 40, evidence: [item({ strength: "STRONG" })] }), // 40
      req({ requirementId: "B", weight: 40, evidence: [item({ strength: "PARTIAL" })] }), // 20
      req({ requirementId: "C", weight: 20, evidence: [item({ strength: "CONTRADICTORY" })] }), // 0
    ];
    const result = computeCandidateScore(requirements) as CandidateScoreResult;
    expect(result.denominator).toBe(100);
    expect(result.numerator).toBe(60);
    expect(result.score).toBe(60);
  });

  it("a known, HR-approved zero-weight requirement participates in the set but contributes zero to both numerator and denominator", () => {
    const requirements = [
      req({ requirementId: "A", weight: 100, evidence: [item({ strength: "STRONG" })] }),
      req({ requirementId: "Z", weight: 0, evidence: [item({ strength: "STRONG" })] }),
    ];
    const result = computeCandidateScore(requirements) as CandidateScoreResult;
    expect(result.denominator).toBe(100);
    expect(result.numerator).toBe(100);
    expect(result.score).toBe(100);
    expect(result.perRequirement.find((r) => r.requirementId === "Z")?.contribution).toBe(0);
  });

  it("UNASSESSED requirement with a valid (non-null) weight is included in the denominator, contributes zero to the numerator", () => {
    const requirements = [
      req({ requirementId: "A", weight: 50, evidence: [item({ strength: "STRONG" })] }),
      req({ requirementId: "B", weight: 50, hasEligibleAssessment: false, evidence: [] }),
    ];
    const result = computeCandidateScore(requirements) as CandidateScoreResult;
    expect(result.denominator).toBe(100);
    expect(result.numerator).toBe(50);
    expect(result.score).toBe(50);
  });
});

describe("computeCandidateScore — NOT_YET_APPROVED blocking (ratified: no partial scoring, no renormalization)", () => {
  it("a live requirement with weight: null (never approved) blocks the entire score, not a partial/renormalized one", () => {
    const requirements = [
      req({ requirementId: "A", weight: 50, evidence: [item({ strength: "STRONG" })] }),
      req({ requirementId: "B", weight: null, hasEligibleAssessment: false, evidence: [] }),
    ];
    const result = computeCandidateScore(requirements) as CandidateScoreBlocked;
    expect(result.computable).toBe(false);
    expect(result.reason).toBe("LIVE_REQUIREMENT_NOT_YET_APPROVED");
    expect(result.requirementIds).toEqual(["B"]);
  });

  it("a legacy eligible Assessment with no resolvable pinned-version weight (weight: null) blocks the score the same way, never falling back to a current-version weight", () => {
    const requirements = [
      req({ requirementId: "A", weight: 50, evidence: [item({ strength: "STRONG" })] }),
      req({ requirementId: "B", weight: null, hasEligibleAssessment: true, evidence: [item({ strength: "STRONG" })] }),
    ];
    const result = computeCandidateScore(requirements) as CandidateScoreBlocked;
    expect(result.computable).toBe(false);
    expect(result.reason).toBe("LIVE_REQUIREMENT_NOT_YET_APPROVED");
    expect(result.requirementIds).toEqual(["B"]);
  });

  it("multiple unresolved-weight requirements are all listed in the block reason, not just the first", () => {
    const requirements = [
      req({ requirementId: "A", weight: null, hasEligibleAssessment: false, evidence: [] }),
      req({ requirementId: "B", weight: null, hasEligibleAssessment: false, evidence: [] }),
      req({ requirementId: "C", weight: 50, evidence: [item({ strength: "STRONG" })] }),
    ];
    const result = computeCandidateScore(requirements) as CandidateScoreBlocked;
    expect(result.computable).toBe(false);
    expect(result.requirementIds.sort()).toEqual(["A", "B"]);
  });
});

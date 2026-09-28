import { describe, expect, it } from "vitest";
import {
  computeCandidateCoverage,
  isCovered,
  isContested,
  isLowConfidenceAssessment,
  isMandatoryGap,
  type CoverageEvidenceItem,
  type CoverageRequirementInput,
} from "./evidence-coverage.js";

function item(overrides: Partial<CoverageEvidenceItem> = {}): CoverageEvidenceItem {
  return { role: "SUPPORTING", strength: "STRONG", confidence: "HIGH", ...overrides };
}

describe("isCovered", () => {
  it("STRONG supporting evidence is covered", () => {
    expect(isCovered([item({ strength: "STRONG" })])).toBe(true);
  });

  it("MODERATE supporting evidence is covered", () => {
    expect(isCovered([item({ strength: "MODERATE" })])).toBe(true);
  });

  it("PARTIAL supporting evidence is not covered", () => {
    expect(isCovered([item({ strength: "PARTIAL" })])).toBe(false);
  });

  it("WEAK supporting evidence is not covered", () => {
    expect(isCovered([item({ strength: "WEAK" })])).toBe(false);
  });

  it("NOT_FOUND is not covered", () => {
    expect(isCovered([item({ strength: "NOT_FOUND" })])).toBe(false);
  });

  it("no evidence at all is not covered", () => {
    expect(isCovered([])).toBe(false);
  });

  it("a STRONG CONSIDERED_REJECTED item does not make the requirement covered", () => {
    expect(isCovered([item({ role: "CONSIDERED_REJECTED", strength: "STRONG" })])).toBe(false);
  });

  it("confidence never changes coverage: LOW-confidence STRONG evidence is still covered", () => {
    expect(isCovered([item({ strength: "STRONG", confidence: "LOW" })])).toBe(true);
  });
});

describe("isContested / CONTRADICTORY handling", () => {
  it("any CONTRADICTORY item forces not-covered, even alongside a STRONG supporting item", () => {
    const evidence = [item({ strength: "STRONG" }), item({ strength: "CONTRADICTORY" })];
    expect(isContested(evidence)).toBe(true);
    expect(isCovered(evidence)).toBe(false);
  });

  it("CONTRADICTORY confidence level does not change the outcome (LOW confidence still contests)", () => {
    const evidence = [item({ strength: "STRONG" }), item({ strength: "CONTRADICTORY", confidence: "LOW" })];
    expect(isContested(evidence)).toBe(true);
    expect(isCovered(evidence)).toBe(false);
  });

  it("a CONTRADICTORY item in any role still contests the requirement", () => {
    const evidence = [item({ role: "CONSIDERED_REJECTED", strength: "CONTRADICTORY" })];
    expect(isContested(evidence)).toBe(true);
  });

  it("multiple CONTRADICTORY items produce the same outcome as one", () => {
    const evidence = [item({ strength: "CONTRADICTORY" }), item({ strength: "CONTRADICTORY" })];
    expect(isContested(evidence)).toBe(true);
    expect(isCovered(evidence)).toBe(false);
  });
});

describe("isLowConfidenceAssessment", () => {
  it("flags a covered requirement whose qualifying evidence is LOW confidence", () => {
    expect(isLowConfidenceAssessment([item({ strength: "STRONG", confidence: "LOW" })])).toBe(true);
  });

  it("does not flag HIGH or MEDIUM confidence", () => {
    expect(isLowConfidenceAssessment([item({ strength: "MODERATE", confidence: "MEDIUM" })])).toBe(false);
    expect(isLowConfidenceAssessment([item({ strength: "STRONG", confidence: "HIGH" })])).toBe(false);
  });

  it("does not apply when the requirement is not covered, even if evidence is LOW confidence", () => {
    expect(isLowConfidenceAssessment([item({ strength: "WEAK", confidence: "LOW" })])).toBe(false);
  });

  it("never changes coverage itself", () => {
    const evidence = [item({ strength: "STRONG", confidence: "LOW" })];
    expect(isCovered(evidence)).toBe(true);
    expect(isLowConfidenceAssessment(evidence)).toBe(true);
  });
});

describe("isMandatoryGap", () => {
  it("mandatory + not covered = gap", () => {
    expect(isMandatoryGap(true, [item({ strength: "PARTIAL" })])).toBe(true);
    expect(isMandatoryGap(true, [item({ strength: "WEAK" })])).toBe(true);
    expect(isMandatoryGap(true, [item({ strength: "NOT_FOUND" })])).toBe(true);
    expect(isMandatoryGap(true, [])).toBe(true);
  });

  it("mandatory + covered = no gap", () => {
    expect(isMandatoryGap(true, [item({ strength: "STRONG" })])).toBe(false);
    expect(isMandatoryGap(true, [item({ strength: "MODERATE" })])).toBe(false);
  });

  it("non-mandatory requirement never produces a gap regardless of coverage", () => {
    expect(isMandatoryGap(false, [item({ strength: "NOT_FOUND" })])).toBe(false);
  });

  it("no intermediate credit: PARTIAL on a mandatory requirement is a full gap, not a partial one", () => {
    expect(isMandatoryGap(true, [item({ strength: "PARTIAL", confidence: "HIGH" })])).toBe(true);
  });
});

describe("computeCandidateCoverage", () => {
  function req(overrides: Partial<CoverageRequirementInput> = {}): CoverageRequirementInput {
    return { requirementId: "r", mandatory: false, weight: 100, evidence: [item()], ...overrides };
  }

  it("100% coverage when the only requirement is covered and fully weighted", () => {
    const result = computeCandidateCoverage([req({ requirementId: "r1", weight: 100, evidence: [item({ strength: "STRONG" })] })]);
    expect(result.coveragePercentage).toBe(100);
    expect(result.status).toBe("COMPLETE");
  });

  it("0% coverage when nothing is covered", () => {
    const result = computeCandidateCoverage([req({ requirementId: "r1", weight: 100, evidence: [item({ strength: "NOT_FOUND" })] })]);
    expect(result.coveragePercentage).toBe(0);
  });

  it("weighted partial coverage across multiple requirements", () => {
    const result = computeCandidateCoverage([
      req({ requirementId: "r1", weight: 60, evidence: [item({ strength: "STRONG" })] }),
      req({ requirementId: "r2", weight: 40, evidence: [item({ strength: "NOT_FOUND" })] }),
    ]);
    expect(result.coveragePercentage).toBe(60);
    expect(result.status).toBe("COMPLETE"); // both requirements scored, weights sum to 100
  });

  it("missing weight (null) excludes the requirement from the numerator but the denominator stays fixed at 100", () => {
    const result = computeCandidateCoverage([
      req({ requirementId: "r1", weight: 70, evidence: [item({ strength: "STRONG" })] }),
      req({ requirementId: "r2", weight: null, evidence: [item({ strength: "STRONG" })] }),
    ]);
    // r2 is fully covered but contributes nothing because its weight is unknown.
    expect(result.coveragePercentage).toBe(70);
    expect(result.scoredWeight).toBe(70);
    expect(result.status).toBe("INCOMPLETE"); // scoredWeight (70) < 100
  });

  it("a candidate can never reach 100% coverage when a requirement is unassessed/unweighted, even with perfect coverage on the rest", () => {
    const result = computeCandidateCoverage([
      req({ requirementId: "r1", weight: 85, evidence: [item({ strength: "STRONG" })] }),
      // r2 (worth 15 of the approved 100) simply absent from this list — never assessed for this candidate.
    ]);
    expect(result.coveragePercentage).toBe(85);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.scoredWeight).toBe(85);
    expect(result.totalWeight).toBe(100);
  });

  it("mandatoryGapCount and lowConfidenceCoveredCount roll up correctly", () => {
    const result = computeCandidateCoverage([
      req({ requirementId: "r1", mandatory: true, weight: 50, evidence: [item({ strength: "NOT_FOUND" })] }),
      req({ requirementId: "r2", mandatory: false, weight: 30, evidence: [item({ strength: "STRONG", confidence: "LOW" })] }),
      req({ requirementId: "r3", mandatory: false, weight: 20, evidence: [item({ strength: "MODERATE", confidence: "HIGH" })] }),
    ]);
    expect(result.mandatoryGapCount).toBe(1);
    expect(result.lowConfidenceCoveredCount).toBe(1);
    expect(result.coveragePercentage).toBe(50); // r2 (30) + r3 (20)
  });

  it("CONTRADICTORY evidence on a requirement removes it from covered weight and never grants partial credit", () => {
    const result = computeCandidateCoverage([
      req({
        requirementId: "r1",
        weight: 100,
        evidence: [item({ strength: "STRONG" }), item({ strength: "CONTRADICTORY" })],
      }),
    ]);
    expect(result.coveragePercentage).toBe(0);
    expect(result.perRequirement[0].contested).toBe(true);
  });

  it("no ranking/rank field exists anywhere on the result", () => {
    const result = computeCandidateCoverage([req()]);
    expect(result).not.toHaveProperty("rank");
    expect(JSON.stringify(result)).not.toContain('"rank"');
  });

  it("empty requirement list yields 0% coverage, INCOMPLETE (nothing scored)", () => {
    const result = computeCandidateCoverage([]);
    expect(result.coveragePercentage).toBe(0);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.scoredWeight).toBe(0);
  });
});

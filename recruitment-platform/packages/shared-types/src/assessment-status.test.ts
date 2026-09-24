import { describe, expect, it } from "vitest";
import { computeAssessmentStatus, computeScoreContribution, strongestSupportingStrength } from "./assessment-status.js";

describe("computeAssessmentStatus (deterministic, AI never assigns this)", () => {
  it("returns STRONG_EVIDENCE for STRONG supporting evidence", () => {
    expect(computeAssessmentStatus(["STRONG"], true)).toBe("STRONG_EVIDENCE");
  });

  it("returns STRONG_EVIDENCE for MODERATE supporting evidence", () => {
    expect(computeAssessmentStatus(["MODERATE"], true)).toBe("STRONG_EVIDENCE");
  });

  it("returns REVIEW_REQUIRED for PARTIAL supporting evidence", () => {
    expect(computeAssessmentStatus(["PARTIAL"], true)).toBe("REVIEW_REQUIRED");
  });

  it("returns REVIEW_REQUIRED for WEAK supporting evidence", () => {
    expect(computeAssessmentStatus(["WEAK"], false)).toBe("REVIEW_REQUIRED");
  });

  it("returns MANDATORY_GAP when no supporting evidence exists and the requirement is mandatory", () => {
    expect(computeAssessmentStatus([], true)).toBe("MANDATORY_GAP");
  });

  it("returns INSUFFICIENT_EVIDENCE when no supporting evidence exists and the requirement is not mandatory", () => {
    expect(computeAssessmentStatus([], false)).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("treats CONTRADICTORY the same as absent evidence", () => {
    expect(computeAssessmentStatus(["CONTRADICTORY"], true)).toBe("MANDATORY_GAP");
    expect(computeAssessmentStatus(["CONTRADICTORY"], false)).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("takes the strongest of several supporting candidates, not the first or last", () => {
    expect(computeAssessmentStatus(["WEAK", "STRONG", "PARTIAL"], true)).toBe("STRONG_EVIDENCE");
  });

  it("NOT_FOUND-only supporting evidence behaves like no evidence", () => {
    expect(computeAssessmentStatus(["NOT_FOUND"], true)).toBe("MANDATORY_GAP");
  });
});

describe("strongestSupportingStrength", () => {
  it("returns NOT_FOUND for an empty list", () => {
    expect(strongestSupportingStrength([])).toBe("NOT_FOUND");
  });

  it("ranks STRONG > MODERATE > PARTIAL > WEAK > CONTRADICTORY/NOT_FOUND", () => {
    expect(strongestSupportingStrength(["WEAK", "MODERATE", "PARTIAL"])).toBe("MODERATE");
  });
});

describe("computeScoreContribution", () => {
  it("scales HR-approved weight by strength for STRONG evidence (full contribution)", () => {
    expect(computeScoreContribution(30, ["STRONG"])).toBeCloseTo(0.3);
  });

  it("scales down for weaker evidence", () => {
    expect(computeScoreContribution(30, ["WEAK"])).toBeCloseTo(0.075);
  });

  it("contributes zero when there is no supporting evidence", () => {
    expect(computeScoreContribution(30, [])).toBe(0);
  });

  it("uses only the strongest candidate when several are supplied", () => {
    expect(computeScoreContribution(40, ["PARTIAL", "STRONG"])).toBeCloseTo(0.4);
  });
});

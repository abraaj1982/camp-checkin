import { describe, expect, it } from "vitest";
import { computeExperienceBreakdown } from "./experience-intelligence.js";

describe("computeExperienceBreakdown", () => {
  it("does not credit a functional area a role never documented", () => {
    // 10 years as HR Manager, but only 6 of those years have documented
    // Employee Relations responsibilities — must not report 10 (Section
    // 13/14 example in the architecture doc).
    const breakdown = computeExperienceBreakdown(
      [
        {
          startDate: "2014-01-01",
          endDate: "2024-01-01",
          isCurrent: false,
          functionalAreaTags: ["HR Administration"],
        },
        {
          startDate: "2018-01-01",
          endDate: "2024-01-01",
          isCurrent: false,
          functionalAreaTags: ["Employee Relations"],
          evidenceStrength: "STRONG",
        },
      ],
      ["Employee Relations"],
      new Date("2024-01-01"),
    );

    expect(breakdown.totalMonths).toBe(120 + 72);
    expect(breakdown.functionalMonths["Employee Relations"]).toBe(72);
    expect(breakdown.relevantMonths).toBe(72);
    expect(breakdown.directlyRelevantMonths).toBe(72);
    expect(breakdown.confidence).toBe("HIGH");
  });

  it("marks confidence LOW when dates are missing rather than guessing", () => {
    const breakdown = computeExperienceBreakdown([
      { startDate: null, endDate: null, isCurrent: false, functionalAreaTags: ["Payroll"] },
    ]);

    expect(breakdown.totalMonths).toBe(0);
    expect(breakdown.confidence).toBe("LOW");
  });

  it("only counts directly-relevant time when evidence is strong or moderate", () => {
    const breakdown = computeExperienceBreakdown(
      [
        {
          startDate: "2020-01-01",
          endDate: "2022-01-01",
          isCurrent: false,
          functionalAreaTags: ["Recruitment"],
          evidenceStrength: "WEAK",
        },
      ],
      ["Recruitment"],
      new Date("2022-01-01"),
    );

    expect(breakdown.relevantMonths).toBe(24);
    expect(breakdown.directlyRelevantMonths).toBe(0);
  });
});

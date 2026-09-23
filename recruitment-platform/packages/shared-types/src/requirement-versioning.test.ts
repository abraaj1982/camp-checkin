import { describe, expect, it } from "vitest";
import { buildRequirementVersionSnapshot, statusAfterEdit } from "./requirement-versioning.js";

describe("buildRequirementVersionSnapshot", () => {
  const source = {
    category: "FUNCTIONAL_EXPERIENCE",
    customCategoryLabel: null,
    description: "Minimum 5 years of Employee Relations experience.",
    mandatory: true,
    priority: "HIGH",
    aiInterpretationSummary: "Requires documented employee relations casework.",
    aiSuggestedWeight: 25,
    criteria: ["Grievance handling", "Disciplinary investigations"],
  };

  it("starts at version 1 for a requirement never approved before", () => {
    const snapshot = buildRequirementVersionSnapshot(source, 0, 25);
    expect(snapshot.versionNumber).toBe(1);
    expect(snapshot.hrApprovedWeight).toBe(25);
    expect(snapshot.evidenceCriteriaSnapshot).toEqual([
      "Grievance handling",
      "Disciplinary investigations",
    ]);
  });

  it("increments from the previous version rather than resetting", () => {
    const snapshot = buildRequirementVersionSnapshot(source, 3, 30);
    expect(snapshot.versionNumber).toBe(4);
  });

  it("copies the criteria array rather than referencing the source array", () => {
    const criteria = ["A", "B"];
    const snapshot = buildRequirementVersionSnapshot({ ...source, criteria }, 0, 25);
    criteria.push("C");
    expect(snapshot.evidenceCriteriaSnapshot).toEqual(["A", "B"]);
  });
});

describe("statusAfterEdit", () => {
  it("keeps a never-approved requirement in DRAFT after an edit", () => {
    expect(statusAfterEdit(0)).toBe("DRAFT");
  });

  it("moves a previously approved requirement to CHANGED after an edit, never silently re-approving it", () => {
    expect(statusAfterEdit(1)).toBe("CHANGED");
    expect(statusAfterEdit(4)).toBe("CHANGED");
  });
});

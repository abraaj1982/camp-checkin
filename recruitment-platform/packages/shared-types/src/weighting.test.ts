import { describe, expect, it } from "vitest";
import { validateWeightTotal, weightChangeRequiresNote } from "./weighting.js";

describe("validateWeightTotal", () => {
  it("accepts weights that total exactly 100", () => {
    const result = validateWeightTotal([
      { requirementId: "a", weight: 40 },
      { requirementId: "b", weight: 60 },
    ]);
    expect(result).toEqual({ valid: true, total: 100 });
  });

  it("accepts a total within floating-point tolerance of 100", () => {
    const result = validateWeightTotal([
      { requirementId: "a", weight: 33.34 },
      { requirementId: "b", weight: 33.33 },
      { requirementId: "c", weight: 33.33 },
    ]);
    expect(result.valid).toBe(true);
  });

  it("rejects a total under 100", () => {
    const result = validateWeightTotal([{ requirementId: "a", weight: 90 }]);
    expect(result).toEqual({ valid: false, total: 90 });
  });

  it("rejects a total over 100", () => {
    const result = validateWeightTotal([
      { requirementId: "a", weight: 70 },
      { requirementId: "b", weight: 40 },
    ]);
    expect(result).toEqual({ valid: false, total: 110 });
  });
});

describe("weightChangeRequiresNote", () => {
  it("does not require a note when HR accepts the AI-suggested weight as-is", () => {
    expect(weightChangeRequiresNote(30, 30)).toBe(false);
  });

  it("requires a note when HR changes the weight away from the AI suggestion", () => {
    expect(weightChangeRequiresNote(30, 45)).toBe(true);
  });

  it("does not require a note when there was no AI suggestion to diverge from", () => {
    expect(weightChangeRequiresNote(null, 45)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { careerConsistencyOutputSchema, requirementEvidenceAnalysisOutputSchema } from "./ai-tasks.js";

describe("requirementEvidenceAnalysisOutputSchema (Phase 4 foundation, Decision 1)", () => {
  it("accepts multiple SUPPORTING and CONSIDERED_REJECTED evidence candidates for the same requirement", () => {
    const result = requirementEvidenceAnalysisOutputSchema.safeParse({
      items: [
        {
          requirementId: "req-1",
          evidenceCandidates: [
            {
              evidenceText: "Led grievance handling and disciplinary investigations.",
              sourcePage: 2,
              evidenceType: "DIRECT",
              evidenceStrength: "STRONG",
              confidence: "HIGH",
              reasoning: "Directly names employee relations casework.",
              role: "SUPPORTING",
            },
            {
              evidenceText: "Managed general HR administration tasks.",
              sourcePage: 1,
              evidenceType: "INFERRED",
              evidenceStrength: "WEAK",
              confidence: "LOW",
              reasoning: "Too generic to count as employee relations specifically.",
              role: "CONSIDERED_REJECTED",
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items[0].evidenceCandidates).toHaveLength(2);
      const roles = result.data.items[0].evidenceCandidates.map((c) => c.role);
      expect(roles).toEqual(["SUPPORTING", "CONSIDERED_REJECTED"]);
    }
  });

  it("accepts a NOT_FOUND-only candidate with no quote to cite", () => {
    const result = requirementEvidenceAnalysisOutputSchema.safeParse({
      items: [
        {
          requirementId: "req-1",
          evidenceCandidates: [
            {
              evidenceText: null,
              sourcePage: null,
              evidenceType: "MISSING",
              evidenceStrength: "NOT_FOUND",
              confidence: "HIGH",
              reasoning: "No mention of this requirement anywhere in the document.",
              role: "CONSIDERED_REJECTED",
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a requirement item with zero evidence candidates (must be explicit, never silently empty)", () => {
    const result = requirementEvidenceAnalysisOutputSchema.safeParse({
      items: [{ requirementId: "req-1", evidenceCandidates: [] }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an evidence candidate with no role", () => {
    const result = requirementEvidenceAnalysisOutputSchema.safeParse({
      items: [
        {
          requirementId: "req-1",
          evidenceCandidates: [
            {
              evidenceText: "Some quote.",
              sourcePage: 1,
              evidenceType: "DIRECT",
              evidenceStrength: "STRONG",
              confidence: "HIGH",
              reasoning: "Reason.",
              // role omitted
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("does not let the AI output assign a final Assessment status (no such field exists on the schema)", () => {
    // The schema has no "status"/"assessmentStatus" field anywhere — this
    // is a structural guarantee, not just a convention: application code
    // literally cannot read an AI-assigned status from a validated
    // RequirementEvidenceAnalysisOutput because the type doesn't have one.
    const shape = requirementEvidenceAnalysisOutputSchema.shape.items.element.shape;
    expect(Object.keys(shape)).toEqual(["requirementId", "evidenceCandidates"]);
    const candidateShape = shape.evidenceCandidates.element.shape;
    expect(Object.keys(candidateShape)).not.toContain("status");
    expect(Object.keys(candidateShape)).not.toContain("assessmentStatus");
  });
});

describe("careerConsistencyOutputSchema (maps directly onto CandidateConsistencyFinding)", () => {
  it("accepts multiple findings of the same findingType", () => {
    const result = careerConsistencyOutputSchema.safeParse({
      progressionNarrative: "Two separate gaps in an otherwise steady HR career.",
      findings: [
        {
          findingType: "EMPLOYMENT_GAP",
          severity: "INFORMATION_UNCLEAR",
          description: "Gap between Acme Corp and Beta Inc.",
          sourcePage: null,
          evidenceText: null,
          confidence: "MEDIUM",
        },
        {
          findingType: "EMPLOYMENT_GAP",
          severity: "VERIFICATION_REQUIRED",
          description: "Gap between Beta Inc and Gamma LLC.",
          sourcePage: null,
          evidenceText: null,
          confidence: "LOW",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.findings).toHaveLength(2);
      expect(result.data.findings.every((f) => f.findingType === "EMPLOYMENT_GAP")).toBe(true);
    }
  });

  it("accepts multiple different finding types in one response", () => {
    const result = careerConsistencyOutputSchema.safeParse({
      progressionNarrative: "Overall steady progression with one chronology issue to verify.",
      findings: [
        {
          findingType: "EMPLOYMENT_GAP",
          severity: "INFORMATION_UNCLEAR",
          description: "Approximately 6-month gap in 2020.",
          sourcePage: null,
          evidenceText: null,
          confidence: "MEDIUM",
        },
        {
          findingType: "OVERLAPPING_DATES",
          severity: "POTENTIAL_INCONSISTENCY",
          description: "Two roles listed with overlapping employment dates.",
          sourcePage: 2,
          evidenceText: "HR Officer, Acme (2019-2021); HR Supervisor, Acme (2020-2022).",
          confidence: "HIGH",
        },
        {
          findingType: "RESPONSIBILITY_SENIORITY_MISMATCH",
          severity: "VERIFICATION_REQUIRED",
          description: "Junior title with senior-level stated responsibilities.",
          sourcePage: 3,
          evidenceText: "As HR Officer, led company-wide HR transformation strategy.",
          confidence: "MEDIUM",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const types = result.data.findings.map((f) => f.findingType).sort();
      expect(types).toEqual(["EMPLOYMENT_GAP", "OVERLAPPING_DATES", "RESPONSIBILITY_SENIORITY_MISMATCH"].sort());
    }
  });

  it("accepts a documentary finding with source document page and quote (sourceDocumentId is resolved by application code, not part of this schema)", () => {
    const result = careerConsistencyOutputSchema.safeParse({
      progressionNarrative: "One chronology issue found.",
      findings: [
        {
          findingType: "UNCLEAR_CHRONOLOGY",
          severity: "VERIFICATION_REQUIRED",
          description: "Two roles listed with overlapping end/start months.",
          sourcePage: 2,
          evidenceText: "HR Officer, Acme (2019-2021); HR Supervisor, Acme (2020-2022).",
          confidence: "MEDIUM",
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.findings[0].sourcePage).toBe(2);
      expect(result.data.findings[0].evidenceText).toContain("HR Supervisor");
    }
    // sourceDocumentId is deliberately absent from the schema entirely.
    const findingShape = careerConsistencyOutputSchema.shape.findings.element.shape;
    expect(Object.keys(findingShape)).not.toContain("sourceDocumentId");
  });

  it("accepts a date-math-derived finding with null source page and evidence text", () => {
    const result = careerConsistencyOutputSchema.safeParse({
      progressionNarrative: "One gap identified from date math alone.",
      findings: [
        {
          findingType: "EMPLOYMENT_GAP",
          severity: "INFORMATION_UNCLEAR",
          description: "Approximately 8-month gap between the two most recent roles.",
          sourcePage: null,
          evidenceText: null,
          confidence: "MEDIUM",
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a finding missing a required field", () => {
    const missingDescription = careerConsistencyOutputSchema.safeParse({
      progressionNarrative: "Narrative.",
      findings: [
        {
          findingType: "EMPLOYMENT_GAP",
          severity: "INFORMATION_UNCLEAR",
          // description omitted
          sourcePage: null,
          evidenceText: null,
          confidence: "MEDIUM",
        },
      ],
    });
    expect(missingDescription.success).toBe(false);

    const missingConfidence = careerConsistencyOutputSchema.safeParse({
      progressionNarrative: "Narrative.",
      findings: [
        {
          findingType: "EMPLOYMENT_GAP",
          severity: "INFORMATION_UNCLEAR",
          description: "A gap.",
          sourcePage: null,
          evidenceText: null,
          // confidence omitted
        },
      ],
    });
    expect(missingConfidence.success).toBe(false);

    const missingSeverity = careerConsistencyOutputSchema.safeParse({
      progressionNarrative: "Narrative.",
      findings: [
        {
          findingType: "EMPLOYMENT_GAP",
          // severity omitted
          description: "A gap.",
          sourcePage: null,
          evidenceText: null,
          confidence: "MEDIUM",
        },
      ],
    });
    expect(missingSeverity.success).toBe(false);
  });

  it("rejects an unknown findingType or severity value", () => {
    const badType = careerConsistencyOutputSchema.safeParse({
      progressionNarrative: "Narrative.",
      findings: [
        {
          findingType: "CANDIDATE_IS_DISHONEST", // not a real enum value — must be rejected
          severity: "INFORMATION_UNCLEAR",
          description: "A gap.",
          sourcePage: null,
          evidenceText: null,
          confidence: "MEDIUM",
        },
      ],
    });
    expect(badType.success).toBe(false);
  });

  it("does not let the AI output produce a final AssessmentStatus or hiring/suitability decision", () => {
    // Structural guarantee, not just convention: neither the top-level
    // output nor a single finding has any field resembling a recruitment
    // decision — application code has nothing to read even by accident.
    const topLevelKeys = Object.keys(careerConsistencyOutputSchema.shape);
    expect(topLevelKeys).toEqual(["progressionNarrative", "findings"]);

    const findingKeys = Object.keys(careerConsistencyOutputSchema.shape.findings.element.shape);
    for (const forbidden of [
      "status",
      "assessmentStatus",
      "decision",
      "suitability",
      "recommendation",
      "hire",
      "reject",
    ]) {
      expect(findingKeys).not.toContain(forbidden);
    }
  });
});

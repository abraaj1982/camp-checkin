import { z } from "zod";

// One task name per row of ai_model_configurations / AiInteraction.taskType.
// Keep this list in sync with packages/db/prisma/schema.prisma AiTaskType.
export const AI_TASK_TYPES = [
  "REQUIREMENT_INTERPRETATION",
  "WEIGHTING_RECOMMENDATION",
  "RESUME_INTELLIGENCE",
  "REQUIREMENT_EVIDENCE_ANALYSIS",
  "CAREER_CONSISTENCY_ANALYSIS",
  "CANDIDATE_COMPARISON",
] as const;

export type AiTaskType = (typeof AI_TASK_TYPES)[number];

export const evidenceStrengthSchema = z.enum([
  "STRONG",
  "MODERATE",
  "PARTIAL",
  "WEAK",
  "NOT_FOUND",
  "CONTRADICTORY",
]);

export const evidenceConfidenceSchema = z.enum(["HIGH", "MEDIUM", "LOW"]);
export const evidenceTypeSchema = z.enum(["DIRECT", "INFERRED", "MISSING"]);

export type EvidenceStrength = z.infer<typeof evidenceStrengthSchema>;
export type EvidenceConfidence = z.infer<typeof evidenceConfidenceSchema>;
export type EvidenceType = z.infer<typeof evidenceTypeSchema>;

// ---- Task 1: Resume Intelligence ------------------------------------------
// One call per candidate. Extracts the normalized profile that every other
// task and the deterministic Experience Intelligence layer builds on.

export const resumeIntelligenceOutputSchema = z.object({
  experiences: z.array(
    z.object({
      employer: z.string(),
      title: z.string(),
      startDate: z.string().nullable(), // ISO date, or null if not documented
      endDate: z.string().nullable(), // null + isCurrent=true for present role
      isCurrent: z.boolean(),
      responsibilities: z.array(z.string()),
      // AI-assigned functional-area tags (e.g. "Employee Relations", "Payroll").
      // Deterministic Experience Intelligence math consumes these tags — the
      // AI does not compute durations or "relevance" itself (see Section:
      // Candidate Experience Intelligence in the architecture doc).
      functionalAreaTags: z.array(z.string()),
      sourcePage: z.number().int().nullable(),
      extractedConfidence: evidenceConfidenceSchema,
    }),
  ),
  education: z.array(
    z.object({
      institution: z.string(),
      degree: z.string().nullable(),
      field: z.string().nullable(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
    }),
  ),
  skills: z.array(z.object({ skillName: z.string(), category: z.string().nullable() })),
  certifications: z.array(
    z.object({
      name: z.string(),
      issuer: z.string().nullable(),
      dateObtained: z.string().nullable(),
    }),
  ),
  languages: z.array(z.object({ language: z.string(), proficiency: z.string().nullable() })),
});

export type ResumeIntelligenceOutput = z.infer<typeof resumeIntelligenceOutputSchema>;

// ---- Task 2: Requirement Evidence Analysis --------------------------------
// One call per candidate, evaluated against every requirement in the project
// at once (Section: AI Task Orchestration, revised — not one call per
// requirement). "Not Found" is a first-class value, never omitted.
//
// Phase 4 foundation decision: a requirement can have MULTIPLE evidence
// candidates — more than one supporting quote, and/or quotes the AI
// considered but judged weaker/irrelevant (role: CONSIDERED_REJECTED).
// This is what AssessmentEvidence (packages/db/prisma/schema.prisma) was
// built to hold; a single evidence-item-per-requirement shape couldn't
// represent it. The AI's job stops at identifying/classifying evidence —
// it never assigns the requirement's final Assessment status. That status
// is computed deterministically by application code from these candidates
// (AI proposes evidence -> application decides the assessment), the same
// division of responsibility as AI-suggested vs. HR-approved weights.

export const evidenceCandidateRoleSchema = z.enum(["SUPPORTING", "CONSIDERED_REJECTED"]);

export const evidenceCandidateSchema = z.object({
  evidenceText: z.string().nullable(), // null only for a NOT_FOUND candidate with no quote to cite
  sourcePage: z.number().int().nullable(),
  evidenceType: evidenceTypeSchema,
  evidenceStrength: evidenceStrengthSchema,
  confidence: evidenceConfidenceSchema,
  reasoning: z.string(), // why this candidate supports or was set aside — never a bare label
  role: evidenceCandidateRoleSchema,
});

export const requirementEvidenceItemSchema = z.object({
  requirementId: z.string(),
  // At least one candidate is required so "no evidence found" is still an
  // explicit, reasoned statement (evidenceStrength: NOT_FOUND), never a
  // silently empty array indistinguishable from "the AI skipped this".
  evidenceCandidates: z.array(evidenceCandidateSchema).min(1),
});

export const requirementEvidenceAnalysisOutputSchema = z.object({
  items: z.array(requirementEvidenceItemSchema),
});

export type EvidenceCandidate = z.infer<typeof evidenceCandidateSchema>;
export type RequirementEvidenceAnalysisOutput = z.infer<
  typeof requirementEvidenceAnalysisOutputSchema
>;

// ---- Task 3: Career / Consistency Analysis --------------------------------
// Revised (Phase 4 foundation follow-up) to map directly onto
// CandidateConsistencyFinding (packages/db/prisma/schema.prisma) — one AI
// call, many findings, each independently typed/severity-tagged/traceable,
// instead of three separately-shaped grouped fields (employmentGaps/
// overlaps/inconsistencies) that couldn't hold more than one instance of a
// given shape cleanly and had no traceability fields at all. Multiple
// findings of the same findingType are expected and normal (e.g. two
// separate EMPLOYMENT_GAP findings for two different gaps) — nothing here
// collapses or dedupes by type.
//
// Enum values are kept in exact sync with the Prisma ConsistencyFindingType/
// ConsistencyFindingSeverity enums (packages/db/prisma/schema.prisma) so a
// validated AI response can be persisted to CandidateConsistencyFinding
// with zero translation. sourceDocumentId is deliberately NOT part of this
// schema — the AI has no way to know a CandidateDocument's database id;
// application code resolves it from the document currently being analyzed,
// the same pattern Evidence already uses for its own sourceDocumentId.
// aiInteractionId is likewise application-assigned, from the AiInteraction
// row the gateway itself writes.

export const consistencyFindingTypeSchema = z.enum([
  "EMPLOYMENT_GAP",
  "OVERLAPPING_DATES",
  "UNCLEAR_CHRONOLOGY",
  "RESPONSIBILITY_SENIORITY_MISMATCH",
  "POTENTIAL_INCONSISTENCY",
  "OTHER",
]);

export const consistencyFindingSeveritySchema = z.enum([
  "INFORMATION_UNCLEAR",
  "VERIFICATION_REQUIRED",
  "POTENTIAL_INCONSISTENCY",
]);

export const consistencyFindingSchema = z.object({
  findingType: consistencyFindingTypeSchema,
  severity: consistencyFindingSeveritySchema, // neutral language only — never a character/integrity judgment
  description: z.string(),
  // Documentary findings (a specific overlap or mismatch quoted from the
  // CV) carry sourcePage/evidenceText; a finding derived purely from date
  // math across already-extracted CandidateExperience rows (e.g. "gap
  // between employer A's end date and employer B's start date") has no
  // single quote to cite and legitimately leaves both null — never
  // fabricated to satisfy a "must have a source" rule.
  sourcePage: z.number().int().nullable(),
  evidenceText: z.string().nullable(),
  confidence: evidenceConfidenceSchema,
});

export const careerConsistencyOutputSchema = z.object({
  // Overall synthesis across the findings below — a narrative summary, not
  // itself a traceable claim requiring a source pin (the individual
  // findings it summarizes carry their own traceability).
  progressionNarrative: z.string(),
  findings: z.array(consistencyFindingSchema),
});

export type ConsistencyFinding = z.infer<typeof consistencyFindingSchema>;
export type CareerConsistencyOutput = z.infer<typeof careerConsistencyOutputSchema>;

// ---- Task 4: Candidate Comparison (on-demand only) ------------------------

export const candidateComparisonOutputSchema = z.object({
  candidateIds: z.array(z.string()),
  comparisonText: z.string(), // must cite differentiators, never rank bluntly
  perRequirementDifferentiators: z.array(
    z.object({
      requirementId: z.string(),
      summary: z.string(),
    }),
  ),
});

export type CandidateComparisonOutput = z.infer<typeof candidateComparisonOutputSchema>;

// ---- Requirement Interpretation (Phase 2, Sections 4 & 5) -----------------
// HR enters requirements manually; this task performs semantic
// interpretation + structured evidence-criteria generation over the
// requirements HR already wrote, per requirement, in one batched call per
// project (not a call per requirement — same call-efficiency principle as
// the candidate-side tasks).

export const semanticRelevanceSchema = z.enum([
  "DIRECT",
  "RELEVANT",
  "PARTIALLY_RELEVANT",
  "NOT_RELEVANT",
]);

export const requirementInterpretationOutputSchema = z.object({
  interpretations: z.array(
    z.object({
      requirementId: z.string(),
      interpretationSummary: z.string(), // plain-language restatement of what the requirement means
      semanticConcepts: z.array(
        z.object({
          concept: z.string(), // e.g. "grievance handling"
          relevance: semanticRelevanceSchema,
          rationale: z.string(), // why this concept relates (or doesn't) — never a bare label
        }),
      ),
      // "What would convincing evidence of this requirement look like inside
      // a CV?" — ordered, concrete criteria (Section 5). Never conflated
      // with whether a given candidate has that evidence; this task defines
      // the requirement's evidence shape once, up front.
      evidenceCriteria: z.array(z.string()),
    }),
  ),
});

export type RequirementInterpretationOutput = z.infer<
  typeof requirementInterpretationOutputSchema
>;

export const weightingRecommendationOutputSchema = z.object({
  weights: z.array(
    z.object({
      requirementId: z.string(),
      suggestedWeight: z.number().min(0).max(100),
      rationale: z.string(),
    }),
  ),
});

export type WeightingRecommendationOutput = z.infer<typeof weightingRecommendationOutputSchema>;

// Maps each task to its output schema so the AI Gateway can validate any
// task's response generically (see packages/ai-gateway/src/gateway.ts).
export const AI_TASK_OUTPUT_SCHEMAS = {
  REQUIREMENT_INTERPRETATION: requirementInterpretationOutputSchema,
  WEIGHTING_RECOMMENDATION: weightingRecommendationOutputSchema,
  RESUME_INTELLIGENCE: resumeIntelligenceOutputSchema,
  REQUIREMENT_EVIDENCE_ANALYSIS: requirementEvidenceAnalysisOutputSchema,
  CAREER_CONSISTENCY_ANALYSIS: careerConsistencyOutputSchema,
  CANDIDATE_COMPARISON: candidateComparisonOutputSchema,
} satisfies Record<AiTaskType, z.ZodTypeAny>;

import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@recruitment-platform/db";
import { AiGateway, AiValidationError } from "@recruitment-platform/ai-gateway";
import { runRequirementEvidenceAnalysis } from "../requirement-evidence-analysis.js";
import { startProcessingRun, failProcessingRun, completeProcessingRun, ProcessingRunAlreadyActiveError } from "../processing-run.js";
import { FakeAIProvider, createUser, resetDatabase, seedAiModelConfig } from "./test-utils.js";

/**
 * Phase 4A: Requirement Evidence Analysis. Calls the function directly
 * (not the full pipeline) so each scenario controls the canned AI response
 * precisely. No live Claude call anywhere — FakeAIProvider only.
 *
 * Each call now runs under an explicit ProcessingRun (startProcessingRun),
 * mirroring how worker/src/pipeline.ts drives this in production.
 */
describe("runRequirementEvidenceAnalysis", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  /** Bypasses the HTTP approval flow (API-only) — seeds an APPROVED requirement + its version + a pinning batch directly. */
  async function seedApprovedRequirementBatch(options: {
    projectTitle?: string;
    mandatory?: boolean;
    hrApprovedWeight?: number;
    description?: string;
  } = {}) {
    const user = await createUser(`hr-${Math.random().toString(36).slice(2)}@example.com`);
    const project = await prisma.recruitmentProject.create({
      data: { title: options.projectTitle ?? "HR Manager", createdBy: user.id },
    });
    const requirement = await prisma.jobRequirement.create({
      data: {
        projectId: project.id,
        category: "FUNCTIONAL_EXPERIENCE",
        description: options.description ?? "5 years Employee Relations",
        mandatory: options.mandatory ?? true,
        status: "APPROVED",
        currentVersionNumber: 1,
        hrApprovedWeight: options.hrApprovedWeight ?? 100,
      },
    });
    const version = await prisma.jobRequirementVersion.create({
      data: {
        requirementId: requirement.id,
        versionNumber: 1,
        category: requirement.category,
        description: requirement.description,
        mandatory: requirement.mandatory,
        priority: "MEDIUM",
        evidenceCriteriaSnapshot: ["Grievance handling", "Disciplinary investigations"],
        hrApprovedWeight: options.hrApprovedWeight ?? 100,
        approvedBy: user.id,
      },
    });
    const batch = await prisma.candidateUploadBatch.create({ data: { projectId: project.id, createdBy: user.id } });
    await prisma.candidateBatchRequirementVersion.create({
      data: { batchId: batch.id, requirementId: requirement.id, requirementVersionId: version.id },
    });
    const candidate = await prisma.candidate.create({ data: { fullName: "resume" } });
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        batchId: batch.id,
        fileType: "pdf",
        storageKey: "s3://bucket/key.pdf",
        originalFilename: "resume.pdf",
        uploadedBy: user.id,
        status: "PROCESSING",
      },
    });
    return { user, project, requirement, version, batch, candidate, document };
  }

  const strongSupportingResponse = (requirementId: string, text = "Led grievance handling.") => ({
    items: [
      {
        requirementId,
        evidenceCandidates: [
          {
            evidenceText: text,
            sourcePage: 1,
            evidenceType: "DIRECT" as const,
            evidenceStrength: "STRONG" as const,
            confidence: "HIGH" as const,
            reasoning: "On-point.",
            role: "SUPPORTING" as const,
          },
        ],
      },
    ],
  });

  const notFoundResponse = (requirementId: string) => ({
    items: [
      {
        requirementId,
        evidenceCandidates: [
          {
            evidenceText: null,
            sourcePage: null,
            evidenceType: "MISSING" as const,
            evidenceStrength: "NOT_FOUND" as const,
            confidence: "HIGH" as const,
            reasoning: "Nothing found.",
            role: "CONSIDERED_REJECTED" as const,
          },
        ],
      },
    ],
  });

  it("persists multiple SUPPORTING evidence candidates for one requirement", async () => {
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const { requirement, candidate, document } = await seedApprovedRequirementBatch();
    const run = await startProcessingRun(document.id);
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        REQUIREMENT_EVIDENCE_ANALYSIS: () => ({
          items: [
            {
              requirementId: requirement.id,
              evidenceCandidates: [
                {
                  evidenceText: "Led grievance handling for 200+ staff.",
                  sourcePage: 2,
                  evidenceType: "DIRECT",
                  evidenceStrength: "STRONG",
                  confidence: "HIGH",
                  reasoning: "Directly on-point.",
                  role: "SUPPORTING",
                },
                {
                  evidenceText: "Conducted disciplinary investigations across two regions.",
                  sourcePage: 3,
                  evidenceType: "DIRECT",
                  evidenceStrength: "MODERATE",
                  confidence: "MEDIUM",
                  reasoning: "Corroborating.",
                  role: "SUPPORTING",
                },
              ],
            },
          ],
        }),
      }),
    });

    await runRequirementEvidenceAnalysis(
      document,
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! },
      "resume text",
      gateway,
      run.id,
    );

    const evidence = await prisma.evidence.findMany({ where: { requirementId: requirement.id } });
    expect(evidence).toHaveLength(2);
    const assessment = await prisma.assessment.findFirstOrThrow({
      where: { requirementId: requirement.id },
      include: { evidenceLinks: true },
    });
    expect(assessment.evidenceLinks.every((l) => l.role === "SUPPORTING")).toBe(true);
    expect(assessment.status).toBe("STRONG_EVIDENCE"); // best supporting = STRONG
    expect(assessment.processingRunId).toBe(run.id);
    expect(assessment.computedScoreContribution).toBeNull(); // no approved scoring formula (Decision 2)
  });

  it("persists SUPPORTING and CONSIDERED_REJECTED evidence for the same requirement, and only SUPPORTING drives status", async () => {
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const { requirement, candidate, document } = await seedApprovedRequirementBatch();
    const run = await startProcessingRun(document.id);
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        REQUIREMENT_EVIDENCE_ANALYSIS: () => ({
          items: [
            {
              requirementId: requirement.id,
              evidenceCandidates: [
                {
                  evidenceText: "Led grievance handling.",
                  sourcePage: 2,
                  evidenceType: "DIRECT",
                  evidenceStrength: "STRONG",
                  confidence: "HIGH",
                  reasoning: "On-point.",
                  role: "SUPPORTING",
                },
                {
                  evidenceText: "Assisted with general HR administration.",
                  sourcePage: 1,
                  evidenceType: "INFERRED",
                  evidenceStrength: "WEAK",
                  confidence: "LOW",
                  reasoning: "Too generic on its own.",
                  role: "CONSIDERED_REJECTED",
                },
              ],
            },
          ],
        }),
      }),
    });

    await runRequirementEvidenceAnalysis(
      document,
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! },
      "resume text",
      gateway,
      run.id,
    );

    const assessment = await prisma.assessment.findFirstOrThrow({
      where: { requirementId: requirement.id },
      include: { evidenceLinks: true },
    });
    const roles = assessment.evidenceLinks.map((l) => l.role).sort();
    expect(roles).toEqual(["CONSIDERED_REJECTED", "SUPPORTING"]);
    // Status reflects the SUPPORTING (STRONG) evidence, not weighed down by the rejected WEAK one.
    expect(assessment.status).toBe("STRONG_EVIDENCE");
  });

  it("evaluates multiple requirements in one call, one Assessment per requirement", async () => {
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const user = await createUser("hr@example.com");
    const project = await prisma.recruitmentProject.create({ data: { title: "HR Manager", createdBy: user.id } });
    const requirementA = await prisma.jobRequirement.create({
      data: {
        projectId: project.id,
        category: "FUNCTIONAL_EXPERIENCE",
        description: "Employee Relations",
        mandatory: true,
        status: "APPROVED",
        currentVersionNumber: 1,
      },
    });
    const requirementB = await prisma.jobRequirement.create({
      data: {
        projectId: project.id,
        category: "TECHNICAL_SKILLS",
        description: "Advanced Excel",
        mandatory: false,
        status: "APPROVED",
        currentVersionNumber: 1,
      },
    });
    const versionA = await prisma.jobRequirementVersion.create({
      data: {
        requirementId: requirementA.id,
        versionNumber: 1,
        category: requirementA.category,
        description: requirementA.description,
        mandatory: true,
        priority: "MEDIUM",
        evidenceCriteriaSnapshot: [],
        hrApprovedWeight: 70,
        approvedBy: user.id,
      },
    });
    const versionB = await prisma.jobRequirementVersion.create({
      data: {
        requirementId: requirementB.id,
        versionNumber: 1,
        category: requirementB.category,
        description: requirementB.description,
        mandatory: false,
        priority: "LOW",
        evidenceCriteriaSnapshot: [],
        hrApprovedWeight: 30,
        approvedBy: user.id,
      },
    });
    const batch = await prisma.candidateUploadBatch.create({ data: { projectId: project.id, createdBy: user.id } });
    await prisma.candidateBatchRequirementVersion.createMany({
      data: [
        { batchId: batch.id, requirementId: requirementA.id, requirementVersionId: versionA.id },
        { batchId: batch.id, requirementId: requirementB.id, requirementVersionId: versionB.id },
      ],
    });
    const candidate = await prisma.candidate.create({ data: { fullName: "resume" } });
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        batchId: batch.id,
        fileType: "pdf",
        storageKey: "s3://bucket/key.pdf",
        originalFilename: "resume.pdf",
        uploadedBy: user.id,
      },
    });
    const run = await startProcessingRun(document.id);

    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        REQUIREMENT_EVIDENCE_ANALYSIS: () => ({
          items: [
            {
              requirementId: requirementA.id,
              evidenceCandidates: [
                {
                  evidenceText: "Led grievance handling.",
                  sourcePage: 1,
                  evidenceType: "DIRECT",
                  evidenceStrength: "STRONG",
                  confidence: "HIGH",
                  reasoning: "On-point.",
                  role: "SUPPORTING",
                },
              ],
            },
            {
              requirementId: requirementB.id,
              evidenceCandidates: [
                {
                  evidenceText: null,
                  sourcePage: null,
                  evidenceType: "MISSING",
                  evidenceStrength: "NOT_FOUND",
                  confidence: "HIGH",
                  reasoning: "No mention of Excel anywhere.",
                  role: "CONSIDERED_REJECTED",
                },
              ],
            },
          ],
        }),
      }),
    });

    await runRequirementEvidenceAnalysis(
      document,
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: project.id },
      "resume text",
      gateway,
      run.id,
    );

    const assessments = await prisma.assessment.findMany({ where: { candidateId: candidate.id } });
    expect(assessments).toHaveLength(2);
    const byRequirement = new Map(assessments.map((a) => [a.requirementId, a]));
    expect(byRequirement.get(requirementA.id)?.status).toBe("STRONG_EVIDENCE");
    // Not mandatory + no supporting evidence -> INSUFFICIENT_EVIDENCE, not MANDATORY_GAP.
    expect(byRequirement.get(requirementB.id)?.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("traces persisted evidence to Requirement -> Assessment -> source document/page/text", async () => {
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const { requirement, candidate, document } = await seedApprovedRequirementBatch();
    const run = await startProcessingRun(document.id);
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        REQUIREMENT_EVIDENCE_ANALYSIS: () => ({
          items: [
            {
              requirementId: requirement.id,
              evidenceCandidates: [
                {
                  evidenceText: "Led grievance handling for 200+ staff.",
                  sourcePage: 4,
                  evidenceType: "DIRECT",
                  evidenceStrength: "STRONG",
                  confidence: "HIGH",
                  reasoning: "On-point.",
                  role: "SUPPORTING",
                },
              ],
            },
          ],
        }),
      }),
    });

    await runRequirementEvidenceAnalysis(
      document,
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! },
      "resume text",
      gateway,
      run.id,
    );

    // Scenario 12: full ProcessingRun -> Assessment -> AssessmentEvidence -> Evidence chain.
    const processingRun = await prisma.processingRun.findUniqueOrThrow({
      where: { id: run.id },
      include: {
        assessments: {
          include: { evidenceLinks: { include: { evidence: { include: { sourceDocument: true } } } } },
        },
      },
    });
    const assessment = processingRun.assessments[0];
    const evidence = assessment.evidenceLinks[0].evidence;
    expect(assessment.requirementId).toBe(requirement.id);
    expect(evidence.requirementId).toBe(requirement.id);
    expect(evidence.sourceDocument?.id).toBe(document.id);
    expect(evidence.sourcePage).toBe(4);
    expect(evidence.evidenceText).toContain("grievance handling");
  });

  it("populates Assessment.requirementVersionId from the batch's pinned version, not a fresh lookup (scenario 13)", async () => {
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const { requirement, version, candidate, document } = await seedApprovedRequirementBatch();
    const run = await startProcessingRun(document.id);

    // Create a SECOND version row that is newer than the pinned one — if
    // the code re-queried "latest version" instead of using the pin, this
    // would leak in and the test would catch it.
    const newerVersion = await prisma.jobRequirementVersion.create({
      data: {
        requirementId: requirement.id,
        versionNumber: 2,
        category: requirement.category,
        description: "A totally different, newer description",
        mandatory: requirement.mandatory,
        priority: "MEDIUM",
        evidenceCriteriaSnapshot: [],
        hrApprovedWeight: 100,
        approvedBy: (await prisma.user.findFirstOrThrow()).id,
      },
    });

    const gateway = new AiGateway({
      fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => strongSupportingResponse(requirement.id) }),
    });

    await runRequirementEvidenceAnalysis(
      document,
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! },
      "resume text",
      gateway,
      run.id,
    );

    const assessment = await prisma.assessment.findFirstOrThrow({ where: { requirementId: requirement.id } });
    expect(assessment.requirementVersionId).toBe(version.id);
    expect(assessment.requirementVersionId).not.toBe(newerVersion.id);
  });

  it("cannot have the AI assign a final AssessmentStatus — status is always one of the deterministic set derived from evidence strength", async () => {
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const { requirement, candidate, document } = await seedApprovedRequirementBatch({ mandatory: true });
    const run = await startProcessingRun(document.id);
    const gateway = new AiGateway({
      fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => notFoundResponse(requirement.id) }),
    });

    await runRequirementEvidenceAnalysis(
      document,
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! },
      "resume text",
      gateway,
      run.id,
    );

    const assessment = await prisma.assessment.findFirstOrThrow({ where: { requirementId: requirement.id } });
    // Deterministically MANDATORY_GAP because the requirement is mandatory
    // and there is no SUPPORTING evidence — this value came from
    // computeAssessmentStatus, not from anything the FakeAIProvider returned
    // (its response has no status field at all — it couldn't have supplied one).
    expect(assessment.status).toBe("MANDATORY_GAP");
  });

  it("handles an invalid AI response safely: throws, and persists no Evidence/Assessment rows, but the ProcessingRun itself is left for the caller to mark FAILED (scenario 14)", async () => {
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const { requirement, candidate, document } = await seedApprovedRequirementBatch();
    const run = await startProcessingRun(document.id);
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        REQUIREMENT_EVIDENCE_ANALYSIS: () => ({ items: [{ requirementId: requirement.id, evidenceCandidates: [] }] }), // violates .min(1)
      }),
    });

    await expect(
      runRequirementEvidenceAnalysis(
        document,
        { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! },
        "resume text",
        gateway,
        run.id,
      ),
    ).rejects.toBeInstanceOf(AiValidationError);

    expect(await prisma.evidence.count({ where: { requirementId: requirement.id } })).toBe(0);
    expect(await prisma.assessment.count({ where: { requirementId: requirement.id } })).toBe(0);

    // Mirrors what pipeline.ts does on a thrown error from this function.
    await failProcessingRun(run.id);
    const failedRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(failedRun.status).toBe("FAILED");
    const doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(doc.currentProcessingRunId).toBeNull(); // no successful run ever existed for this document
  });

  it("keeps evidence/assessments isolated between two different projects", async () => {
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const seedA = await seedApprovedRequirementBatch({ projectTitle: "Project A" });
    const seedB = await seedApprovedRequirementBatch({ projectTitle: "Project B" });
    const runA = await startProcessingRun(seedA.document.id);
    const runB = await startProcessingRun(seedB.document.id);

    const gatewayFor = (requirementId: string) =>
      new AiGateway({ fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => strongSupportingResponse(requirementId, "Some evidence.") }) });

    await runRequirementEvidenceAnalysis(
      seedA.document,
      { candidateDocumentId: seedA.document.id, candidateId: seedA.candidate.id, projectId: seedA.project.id },
      "resume text",
      gatewayFor(seedA.requirement.id),
      runA.id,
    );
    await runRequirementEvidenceAnalysis(
      seedB.document,
      { candidateDocumentId: seedB.document.id, candidateId: seedB.candidate.id, projectId: seedB.project.id },
      "resume text",
      gatewayFor(seedB.requirement.id),
      runB.id,
    );

    const evidenceA = await prisma.evidence.findMany({ where: { projectId: seedA.project.id } });
    const evidenceB = await prisma.evidence.findMany({ where: { projectId: seedB.project.id } });
    expect(evidenceA).toHaveLength(1);
    expect(evidenceB).toHaveLength(1);
    expect(evidenceA[0].candidateId).toBe(seedA.candidate.id);
    expect(evidenceB[0].candidateId).toBe(seedB.candidate.id);
    expect(evidenceA[0].requirementId).not.toBe(evidenceB[0].requirementId);
  });

  it("handles a candidate with no matching evidence for a mandatory requirement: MANDATORY_GAP, not silently rejected", async () => {
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const { requirement, candidate, document } = await seedApprovedRequirementBatch({ mandatory: true });
    const run = await startProcessingRun(document.id);
    const gateway = new AiGateway({
      fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => notFoundResponse(requirement.id) }),
    });

    await runRequirementEvidenceAnalysis(
      document,
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! },
      "resume text",
      gateway,
      run.id,
    );

    const assessment = await prisma.assessment.findFirstOrThrow({ where: { requirementId: requirement.id } });
    expect(assessment.status).toBe("MANDATORY_GAP");
    // The candidate is never hidden or deleted — the row exists and is visible.
    const stillExists = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    expect(stillExists).not.toBeNull();
  });

  it("drops a duplicate requirementId within one AI response rather than failing the whole transaction", async () => {
    await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
    const { requirement, candidate, document } = await seedApprovedRequirementBatch();
    const run = await startProcessingRun(document.id);
    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        REQUIREMENT_EVIDENCE_ANALYSIS: () => ({
          items: [
            ...strongSupportingResponse(requirement.id, "First mention.").items,
            ...strongSupportingResponse(requirement.id, "Duplicate mention.").items,
          ],
        }),
      }),
    });

    await runRequirementEvidenceAnalysis(
      document,
      { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! },
      "resume text",
      gateway,
      run.id,
    );

    const assessments = await prisma.assessment.findMany({ where: { requirementId: requirement.id, processingRunId: run.id } });
    expect(assessments).toHaveLength(1); // second duplicate item was dropped, not persisted or errored
  });

  describe("ProcessingRun retry semantics (Phase 4A)", () => {
    it("1. first successful run becomes CandidateDocument.currentProcessingRunId", async () => {
      await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
      const { requirement, candidate, document } = await seedApprovedRequirementBatch();
      const run = await startProcessingRun(document.id);
      const gateway = new AiGateway({
        fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => strongSupportingResponse(requirement.id) }),
      });

      await runRequirementEvidenceAnalysis(
        document,
        { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! },
        "resume text",
        gateway,
        run.id,
      );
      await completeProcessingRun(run.id, document.id);

      const doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(doc.currentProcessingRunId).toBe(run.id);
      const completedRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
      expect(completedRun.status).toBe("COMPLETED");
      expect(completedRun.completedAt).not.toBeNull();
    });

    it("2. a failed first run leaves currentProcessingRunId null", async () => {
      const { document } = await seedApprovedRequirementBatch();
      const run = await startProcessingRun(document.id);
      await failProcessingRun(run.id);

      const doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(doc.currentProcessingRunId).toBeNull();
    });

    it("3. a successful retry creates a NEW ProcessingRun with a distinct id and higher attemptNumber", async () => {
      await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
      const { requirement, candidate, document } = await seedApprovedRequirementBatch();
      const gateway = new AiGateway({
        fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => strongSupportingResponse(requirement.id) }),
      });
      const jobData = { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! };

      const run1 = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", gateway, run1.id);
      await completeProcessingRun(run1.id, document.id);

      const run2 = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", gateway, run2.id);
      await completeProcessingRun(run2.id, document.id);

      expect(run2.id).not.toBe(run1.id);
      expect(run2.attemptNumber).toBeGreaterThan(run1.attemptNumber);
    });

    it("4 & 5 & 16. a successful retry does not delete the old Assessment or Evidence — no historical row is ever deleted", async () => {
      await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
      const { requirement, candidate, document } = await seedApprovedRequirementBatch();
      const gateway = new AiGateway({
        fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => strongSupportingResponse(requirement.id) }),
      });
      const jobData = { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! };

      const run1 = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", gateway, run1.id);
      await completeProcessingRun(run1.id, document.id);
      const assessment1 = await prisma.assessment.findFirstOrThrow({ where: { processingRunId: run1.id } });
      const evidence1 = await prisma.evidence.findMany({ where: { requirementId: requirement.id } });

      const run2 = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", gateway, run2.id);
      await completeProcessingRun(run2.id, document.id);

      // The first run's Assessment row still exists, untouched.
      const stillThere = await prisma.assessment.findUnique({ where: { id: assessment1.id } });
      expect(stillThere).not.toBeNull();
      expect(stillThere?.status).toBe(assessment1.status);

      // Both runs' Evidence rows exist — nothing was deleted.
      const allEvidence = await prisma.evidence.findMany({ where: { requirementId: requirement.id } });
      expect(allEvidence.length).toBeGreaterThanOrEqual(evidence1.length * 2);

      // Two Assessment rows total now exist for this requirement, one per run.
      const allAssessments = await prisma.assessment.findMany({ where: { requirementId: requirement.id } });
      expect(allAssessments).toHaveLength(2);
    });

    it("6. after a successful retry, the old ProcessingRun stays in its previous terminal state and the new run is COMPLETED", async () => {
      await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
      const { requirement, candidate, document } = await seedApprovedRequirementBatch();
      const gateway = new AiGateway({
        fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => strongSupportingResponse(requirement.id) }),
      });
      const jobData = { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! };

      const run1 = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", gateway, run1.id);
      await completeProcessingRun(run1.id, document.id);

      const run2 = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", gateway, run2.id);
      await completeProcessingRun(run2.id, document.id);

      const finalRun1 = await prisma.processingRun.findUniqueOrThrow({ where: { id: run1.id } });
      const finalRun2 = await prisma.processingRun.findUniqueOrThrow({ where: { id: run2.id } });
      expect(finalRun1.status).toBe("COMPLETED"); // its own terminal state, unchanged by the retry
      expect(finalRun2.status).toBe("COMPLETED");
    });

    it("7. currentProcessingRunId points to the new successful run after a retry", async () => {
      await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
      const { requirement, candidate, document } = await seedApprovedRequirementBatch();
      const gateway = new AiGateway({
        fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => strongSupportingResponse(requirement.id) }),
      });
      const jobData = { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! };

      const run1 = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", gateway, run1.id);
      await completeProcessingRun(run1.id, document.id);

      const run2 = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", gateway, run2.id);
      await completeProcessingRun(run2.id, document.id);

      const doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(doc.currentProcessingRunId).toBe(run2.id);
    });

    it("8 & 15. a failed retry does NOT replace an existing successful current run", async () => {
      await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
      const { requirement, candidate, document } = await seedApprovedRequirementBatch();
      const jobData = { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! };

      const okGateway = new AiGateway({
        fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => strongSupportingResponse(requirement.id) }),
      });
      const run1 = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", okGateway, run1.id);
      await completeProcessingRun(run1.id, document.id);

      const badGateway = new AiGateway({
        fake: new FakeAIProvider({
          REQUIREMENT_EVIDENCE_ANALYSIS: () => ({ items: [{ requirementId: requirement.id, evidenceCandidates: [] }] }), // invalid
        }),
      });
      const run2 = await startProcessingRun(document.id);
      await expect(runRequirementEvidenceAnalysis(document, jobData, "resume text", badGateway, run2.id)).rejects.toBeInstanceOf(
        AiValidationError,
      );
      await failProcessingRun(run2.id);

      const doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(doc.currentProcessingRunId).toBe(run1.id); // still the previous successful run
      const failedRun2 = await prisma.processingRun.findUniqueOrThrow({ where: { id: run2.id } });
      expect(failedRun2.status).toBe("FAILED");
    });

    it("9. two requirements in one run cannot create duplicate Assessment rows for the same requirement (unique constraint)", async () => {
      await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
      const { requirement, document } = await seedApprovedRequirementBatch();
      const run = await startProcessingRun(document.id);

      await prisma.assessment.create({
        data: {
          candidateId: (await prisma.candidate.findFirstOrThrow()).id,
          projectId: document.projectId!,
          requirementId: requirement.id,
          requirementVersionId: (await prisma.jobRequirementVersion.findFirstOrThrow()).id,
          processingRunId: run.id,
          aiAssessmentSummary: "first",
          status: "STRONG_EVIDENCE",
        },
      });

      await expect(
        prisma.assessment.create({
          data: {
            candidateId: (await prisma.candidate.findFirstOrThrow()).id,
            projectId: document.projectId!,
            requirementId: requirement.id,
            requirementVersionId: (await prisma.jobRequirementVersion.findFirstOrThrow()).id,
            processingRunId: run.id,
            aiAssessmentSummary: "duplicate",
            status: "STRONG_EVIDENCE",
          },
        }),
      ).rejects.toThrow(); // unique([processingRunId, requirementId]) violation
    });

    it("10. attempt numbers are unique per document (unique constraint enforced)", async () => {
      const { document } = await seedApprovedRequirementBatch();
      const run1 = await startProcessingRun(document.id);

      await expect(
        prisma.processingRun.create({
          data: { candidateDocumentId: document.id, attemptNumber: run1.attemptNumber, status: "RUNNING" },
        }),
      ).rejects.toThrow(); // unique([candidateDocumentId, attemptNumber]) violation
    });

    it("11. concurrent startProcessingRun calls for the same document: exactly one succeeds, the rest are refused, and no attempt number collides or is skipped incorrectly", async () => {
      const { document } = await seedApprovedRequirementBatch();

      const results = await Promise.allSettled([
        startProcessingRun(document.id),
        startProcessingRun(document.id),
        startProcessingRun(document.id),
      ]);

      const fulfilled = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof startProcessingRun>>> => r.status === "fulfilled");
      const rejected = results.filter((r) => r.status === "rejected");
      expect(fulfilled).toHaveLength(1); // only the first to acquire the document row lock creates a run
      expect(rejected).toHaveLength(2);
      for (const r of rejected as PromiseRejectedResult[]) {
        expect(r.reason).toBeInstanceOf(ProcessingRunAlreadyActiveError);
      }

      // The refused attempts rolled back their attempt-number claim along
      // with the rest of their transaction — no gaps, no collisions.
      expect(fulfilled[0].value.attemptNumber).toBe(1);
      const doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(doc.processingAttemptCounter).toBe(1);
      const runs = await prisma.processingRun.findMany({ where: { candidateDocumentId: document.id } });
      expect(runs).toHaveLength(1);
    });

    it("12. an active RUNNING run prevents another run from starting for the same document (concurrency invariant)", async () => {
      const { document } = await seedApprovedRequirementBatch();
      const activeRun = await startProcessingRun(document.id);
      expect(activeRun.status).toBe("RUNNING");

      await expect(startProcessingRun(document.id)).rejects.toBeInstanceOf(ProcessingRunAlreadyActiveError);

      // The active run is completely untouched by the refused attempt — no
      // silent invalidation, no status change, no extra row created.
      const stillRunning = await prisma.processingRun.findUniqueOrThrow({ where: { id: activeRun.id } });
      expect(stillRunning.status).toBe("RUNNING");
      const runs = await prisma.processingRun.findMany({ where: { candidateDocumentId: document.id } });
      expect(runs).toHaveLength(1);
    });

    it("a RUNNING run left behind by a crashed worker is never silently invalidated — it stays RUNNING and blocks new attempts until an explicit resolution path handles it", async () => {
      const { document } = await seedApprovedRequirementBatch();

      // Simulates a crashed worker: a run left at RUNNING forever — there is
      // no heartbeat/timeout, and startProcessingRun() must not guess.
      const stuckRun = await startProcessingRun(document.id);
      expect(stuckRun.status).toBe("RUNNING");

      // Every subsequent attempt to process this document refuses, rather
      // than marking the stuck run FAILED on its own initiative.
      await expect(startProcessingRun(document.id)).rejects.toBeInstanceOf(ProcessingRunAlreadyActiveError);
      const stillStuck = await prisma.processingRun.findUniqueOrThrow({ where: { id: stuckRun.id } });
      expect(stillStuck.status).toBe("RUNNING"); // untouched — no silent staleness inference

      const doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(doc.currentProcessingRunId).toBeNull();

      // Path 1 from the module docs: the run reports its OWN outcome via an
      // actual pipeline failure. Only after that does a new attempt succeed.
      await failProcessingRun(stuckRun.id);
      const resolvedRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: stuckRun.id } });
      expect(resolvedRun.status).toBe("FAILED");

      const nextRun = await startProcessingRun(document.id);
      expect(nextRun.status).toBe("RUNNING");
      expect(nextRun.id).not.toBe(stuckRun.id);
    });

    it("finalization sequence: a previously-successful run stays current when a later run fails before finalization; a later successful run replaces it", async () => {
      await seedAiModelConfig("REQUIREMENT_EVIDENCE_ANALYSIS");
      const { requirement, candidate, document } = await seedApprovedRequirementBatch();
      const jobData = { candidateDocumentId: document.id, candidateId: candidate.id, projectId: document.projectId! };

      // Step 1: a previous successful ProcessingRun is current.
      const okGateway = new AiGateway({
        fake: new FakeAIProvider({ REQUIREMENT_EVIDENCE_ANALYSIS: () => strongSupportingResponse(requirement.id) }),
      });
      const previousRun = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", okGateway, previousRun.id);
      await completeProcessingRun(previousRun.id, document.id);
      let doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(doc.currentProcessingRunId).toBe(previousRun.id);

      // Step 2: a new ProcessingRun starts, and the processing step fails
      // BEFORE finalization (never reaches completeProcessingRun) —
      // mirrors worker/src/pipeline.ts's catch block around
      // runRequirementEvidenceAnalysis, which calls failProcessingRun and
      // rethrows without ever calling completeProcessingRun.
      const badGateway = new AiGateway({
        fake: new FakeAIProvider({
          REQUIREMENT_EVIDENCE_ANALYSIS: () => ({ items: [{ requirementId: requirement.id, evidenceCandidates: [] }] }), // invalid
        }),
      });
      const failingRun = await startProcessingRun(document.id);
      await expect(
        runRequirementEvidenceAnalysis(document, jobData, "resume text", badGateway, failingRun.id),
      ).rejects.toBeInstanceOf(AiValidationError);
      await failProcessingRun(failingRun.id); // what pipeline.ts's catch block does — finalization never runs

      // The new run is FAILED, and currentProcessingRunId is untouched —
      // still the previous successful run, not null and not the failing one.
      const failedRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: failingRun.id } });
      expect(failedRun.status).toBe("FAILED");
      doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(doc.currentProcessingRunId).toBe(previousRun.id);

      // Step 3 (the opposite direction): a later run succeeds and reaches
      // COMPLETED — currentProcessingRunId now changes to this new run,
      // and the earlier successful run is left exactly as it was.
      const nextRun = await startProcessingRun(document.id);
      await runRequirementEvidenceAnalysis(document, jobData, "resume text", okGateway, nextRun.id);
      await completeProcessingRun(nextRun.id, document.id);

      doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(doc.currentProcessingRunId).toBe(nextRun.id);
      const finalNextRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: nextRun.id } });
      expect(finalNextRun.status).toBe("COMPLETED");
      const finalPreviousRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: previousRun.id } });
      expect(finalPreviousRun.status).toBe("COMPLETED"); // unchanged by the later run's success
    });

    it("transaction-boundary: if finalization's ProcessingRun update conflicts, currentProcessingRunId is not updated to a run it never committed for", async () => {
      const { document } = await seedApprovedRequirementBatch();
      const run = await startProcessingRun(document.id);

      // Simulate the finalization transaction failing entirely by deleting the
      // run first (foreign key on the update then fails) — no assessment work
      // needed here since we're isolating completeProcessingRun's atomicity.
      await prisma.processingRun.delete({ where: { id: run.id } });

      await expect(completeProcessingRun(run.id, document.id)).rejects.toThrow();

      const doc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
      expect(doc.currentProcessingRunId).toBeNull(); // never updated — the transaction as a whole never committed
    });
  });
});

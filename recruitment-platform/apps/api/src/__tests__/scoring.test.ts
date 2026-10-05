import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@recruitment-platform/db";
import { computeLiveCandidateScore } from "../modules/assessments/scoring.js";
import { resetDatabase, createUser } from "./test-utils.js";

/**
 * V1 Live Candidate Scoring (Score Evidence Eligibility decision paper,
 * Checkpoint 3, Decisions 1-12, all ratified). Tests the DB-orchestration
 * layer only — pure Evaluation State / numeric arithmetic is covered in
 * packages/shared-types/src/scoring.test.ts. These tests prove
 * computeLiveCandidateScore correctly assembles ScoringRequirementInputs
 * from real Assessment/Evidence/CandidateProjectAuthority/JobRequirement
 * rows, reusing resolveEligibleAssessments unchanged.
 */
describe("computeLiveCandidateScore", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedProject() {
    const email = `hr-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await createUser(email, "HR_USER");
    const project = await prisma.recruitmentProject.create({
      data: { title: "Scoring Test Project", createdBy: user.id },
    });
    return { user, project };
  }

  async function seedCandidate() {
    return prisma.candidate.create({ data: { fullName: "Scoring Test Candidate" } });
  }

  async function seedAuthority(candidateId: string, projectId: string, currentProcessingRunId: string | null = null) {
    return prisma.candidateProjectAuthority.create({
      data: { candidateId, projectId, currentProcessingRunId },
    });
  }

  /** Approved requirement, with a real JobRequirementVersion row (versionNumber 1). */
  async function seedApprovedRequirement(projectId: string, userId: string, weight: number) {
    const requirement = await prisma.jobRequirement.create({
      data: {
        projectId,
        category: "FUNCTIONAL_EXPERIENCE",
        description: "Scoring test requirement",
        mandatory: false,
        status: "APPROVED",
        currentVersionNumber: 1,
        hrApprovedWeight: weight,
      },
    });
    const version = await prisma.jobRequirementVersion.create({
      data: {
        requirementId: requirement.id,
        versionNumber: 1,
        category: requirement.category,
        description: requirement.description,
        mandatory: false,
        priority: "MEDIUM",
        evidenceCriteriaSnapshot: [],
        hrApprovedWeight: weight,
        approvedBy: userId,
      },
    });
    return { requirement, version };
  }

  /** Never-approved requirement: currentVersionNumber stays 0, no JobRequirementVersion row exists. */
  async function seedNeverApprovedRequirement(projectId: string) {
    return prisma.jobRequirement.create({
      data: {
        projectId,
        category: "FUNCTIONAL_EXPERIENCE",
        description: "Never-approved scoring test requirement",
        mandatory: false,
        status: "DRAFT",
        currentVersionNumber: 0,
      },
    });
  }

  async function seedDocumentAndRun(candidateId: string, projectId: string, uploaderId: string) {
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId,
        projectId,
        fileType: "pdf",
        storageKey: "s3://bucket/key.pdf",
        originalFilename: "resume.pdf",
        uploadedBy: uploaderId,
      },
    });
    const run = await prisma.processingRun.create({
      data: { candidateDocumentId: document.id, attemptNumber: 1, status: "COMPLETED", completedAt: new Date() },
    });
    return { document, run };
  }

  async function seedAssessment(params: {
    candidateId: string;
    projectId: string;
    requirementId: string;
    requirementVersionId?: string | null;
    processingRunId: string;
    evidence?: { role: "SUPPORTING" | "CONSIDERED_REJECTED"; strength: string }[];
  }) {
    const assessment = await prisma.assessment.create({
      data: {
        candidateId: params.candidateId,
        projectId: params.projectId,
        requirementId: params.requirementId,
        requirementVersionId: params.requirementVersionId ?? null,
        processingRunId: params.processingRunId,
        aiAssessmentSummary: "Scoring test assessment.",
        status: "INSUFFICIENT_EVIDENCE",
      },
    });
    for (const e of params.evidence ?? []) {
      const evidence = await prisma.evidence.create({
        data: {
          requirementId: params.requirementId,
          candidateId: params.candidateId,
          projectId: params.projectId,
          evidenceType: "DIRECT",
          evidenceStrength: e.strength as never,
          confidence: "HIGH",
        },
      });
      await prisma.assessmentEvidence.create({
        data: { assessmentId: assessment.id, evidenceId: evidence.id, role: e.role },
      });
    }
    return assessment;
  }

  it("1-2. ESTABLISHED evidence + fixed denominator: full weight contributes, denominator = full live-set weight", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const { requirement, version } = await seedApprovedRequirement(project.id, user.id, 100);
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);
    await seedAuthority(candidate.id, project.id, run.id);
    await seedAssessment({
      candidateId: candidate.id,
      projectId: project.id,
      requirementId: requirement.id,
      requirementVersionId: version.id,
      processingRunId: run.id,
      evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });

    const result = await computeLiveCandidateScore(prisma, candidate.id, project.id);
    expect(result.computable).toBe(true);
    if (result.computable) {
      expect(result.denominator).toBe(100);
      expect(result.numerator).toBe(100);
      expect(result.score).toBe(100);
      expect(result.perRequirement[0].state).toBe("ESTABLISHED");
    }
  });

  it("3. a known, HR-approved zero-weight requirement participates in the set but contributes zero", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const { requirement: reqA, version: versionA } = await seedApprovedRequirement(project.id, user.id, 100);
    const { requirement: reqZero, version: versionZero } = await seedApprovedRequirement(project.id, user.id, 0);
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);
    await seedAuthority(candidate.id, project.id, run.id);
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: reqA.id, requirementVersionId: versionA.id,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: reqZero.id, requirementVersionId: versionZero.id,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });

    const result = await computeLiveCandidateScore(prisma, candidate.id, project.id);
    expect(result.computable).toBe(true);
    if (result.computable) {
      expect(result.denominator).toBe(100);
      expect(result.numerator).toBe(100);
    }
  });

  it("4. UNASSESSED requirement with a valid (current-version) weight is included in the denominator, contributes zero", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const { requirement: reqA, version: versionA } = await seedApprovedRequirement(project.id, user.id, 50);
    await seedApprovedRequirement(project.id, user.id, 50); // reqB: approved, but never assessed for this candidate
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);
    await seedAuthority(candidate.id, project.id, run.id);
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: reqA.id, requirementVersionId: versionA.id,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });

    const result = await computeLiveCandidateScore(prisma, candidate.id, project.id);
    expect(result.computable).toBe(true);
    if (result.computable) {
      expect(result.denominator).toBe(100); // both requirements' weights counted
      expect(result.numerator).toBe(50); // only reqA's ESTABLISHED contribution
      const unassessed = result.perRequirement.find((r) => r.state === "UNASSESSED");
      expect(unassessed?.weight).toBe(50);
      expect(unassessed?.contribution).toBe(0);
    }
  });

  it("5-6. a never-approved live requirement blocks the score (LIVE_REQUIREMENT_NOT_YET_APPROVED), even alongside approved ones", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const { requirement: reqA, version: versionA } = await seedApprovedRequirement(project.id, user.id, 100);
    const reqNeverApproved = await seedNeverApprovedRequirement(project.id);
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);
    await seedAuthority(candidate.id, project.id, run.id);
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: reqA.id, requirementVersionId: versionA.id,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });

    const result = await computeLiveCandidateScore(prisma, candidate.id, project.id);
    expect(result.computable).toBe(false);
    if (!result.computable && result.reason !== "PII_PURGED") {
      expect(result.reason).toBe("LIVE_REQUIREMENT_NOT_YET_APPROVED");
      expect(result.requirementIds).toEqual([reqNeverApproved.id]);
    }
  });

  it("7. an eligible Assessment uses its own pinned requirementVersion weight, not the requirement's current version weight", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const requirement = await prisma.jobRequirement.create({
      data: {
        projectId: project.id, category: "FUNCTIONAL_EXPERIENCE", description: "Re-weighted requirement",
        mandatory: false, status: "APPROVED", currentVersionNumber: 2, hrApprovedWeight: 80,
      },
    });
    const oldVersion = await prisma.jobRequirementVersion.create({
      data: {
        requirementId: requirement.id, versionNumber: 1, category: requirement.category, description: requirement.description,
        mandatory: false, priority: "MEDIUM", evidenceCriteriaSnapshot: [], hrApprovedWeight: 30, approvedBy: user.id,
      },
    });
    await prisma.jobRequirementVersion.create({
      data: {
        requirementId: requirement.id, versionNumber: 2, category: requirement.category, description: requirement.description,
        mandatory: false, priority: "MEDIUM", evidenceCriteriaSnapshot: [], hrApprovedWeight: 80, approvedBy: user.id,
      },
    });
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);
    await seedAuthority(candidate.id, project.id, run.id);
    // Assessment pinned to the OLD version (30), even though current is version 2 (80).
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: requirement.id, requirementVersionId: oldVersion.id,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });

    const result = await computeLiveCandidateScore(prisma, candidate.id, project.id);
    expect(result.computable).toBe(true);
    if (result.computable) {
      expect(result.denominator).toBe(30); // pinned version's weight, never the current version's 80
      expect(result.numerator).toBe(30);
    }
  });

  it("8. a legacy eligible Assessment with requirementVersionId = NULL blocks scoring, never falling back to the current version", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const { requirement } = await seedApprovedRequirement(project.id, user.id, 100);
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);
    await seedAuthority(candidate.id, project.id, run.id);
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: requirement.id, requirementVersionId: null,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });

    const result = await computeLiveCandidateScore(prisma, candidate.id, project.id);
    expect(result.computable).toBe(false);
    if (!result.computable && result.reason !== "PII_PURGED") {
      expect(result.reason).toBe("LIVE_REQUIREMENT_NOT_YET_APPROVED");
      expect(result.requirementIds).toEqual([requirement.id]);
    }
  });

  it("9-10. multiple requirements with distinct weights: correct numerator/denominator/percentage arithmetic", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const { requirement: reqA, version: versionA } = await seedApprovedRequirement(project.id, user.id, 40);
    const { requirement: reqB, version: versionB } = await seedApprovedRequirement(project.id, user.id, 40);
    const { requirement: reqC, version: versionC } = await seedApprovedRequirement(project.id, user.id, 20);
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);
    await seedAuthority(candidate.id, project.id, run.id);
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: reqA.id, requirementVersionId: versionA.id,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: reqB.id, requirementVersionId: versionB.id,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "PARTIAL" }],
    });
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: reqC.id, requirementVersionId: versionC.id,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "CONTRADICTORY" }],
    });

    const result = await computeLiveCandidateScore(prisma, candidate.id, project.id);
    expect(result.computable).toBe(true);
    if (result.computable) {
      expect(result.denominator).toBe(100);
      expect(result.numerator).toBe(40 + 20 + 0); // ESTABLISHED(40) + PARTIAL(40*0.5=20) + CONTESTED(0)
      expect(result.score).toBe(60);
    }
  });

  it("excludes an ARCHIVED requirement from the live set entirely", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const { requirement: reqA, version: versionA } = await seedApprovedRequirement(project.id, user.id, 100);
    const archived = await seedApprovedRequirement(project.id, user.id, 50);
    await prisma.jobRequirement.update({ where: { id: archived.requirement.id }, data: { status: "ARCHIVED" } });
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);
    await seedAuthority(candidate.id, project.id, run.id);
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: reqA.id, requirementVersionId: versionA.id,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });

    const result = await computeLiveCandidateScore(prisma, candidate.id, project.id);
    expect(result.computable).toBe(true);
    if (result.computable) {
      expect(result.denominator).toBe(100); // archived requirement's 50 never counted
      expect(result.perRequirement).toHaveLength(1);
    }
  });

  it("refuses scoring for a PII-purged candidate, never querying eligibility", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    await prisma.candidate.update({ where: { id: candidate.id }, data: { piiPurgedAt: new Date() } });
    const { requirement } = await seedApprovedRequirement(project.id, user.id, 100);
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);
    await seedAuthority(candidate.id, project.id, run.id);
    await seedAssessment({
      candidateId: candidate.id, projectId: project.id, requirementId: requirement.id,
      processingRunId: run.id, evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });

    const result = await computeLiveCandidateScore(prisma, candidate.id, project.id);
    expect(result.computable).toBe(false);
    if (!result.computable) {
      expect(result.reason).toBe("PII_PURGED");
    }
  });

  it("multi-project authority independence: a non-authoritative run's Assessment is not eligible and does not affect the score", async () => {
    const { user, project: projectA } = await seedProject();
    const { user: userB, project: projectB } = await seedProject();
    const candidate = await seedCandidate();
    await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId: projectA.id, anonymizedLabel: "Candidate #001" },
    });
    const { requirement, version } = await seedApprovedRequirement(projectA.id, user.id, 100);
    const { run: runA } = await seedDocumentAndRun(candidate.id, projectA.id, user.id);
    await seedAuthority(candidate.id, projectA.id, runA.id);
    await seedAssessment({
      candidateId: candidate.id, projectId: projectA.id, requirementId: requirement.id, requirementVersionId: version.id,
      processingRunId: runA.id, evidence: [{ role: "SUPPORTING", strength: "STRONG" }],
    });

    // Unrelated Project B authority/run for the same candidate must not leak in.
    const { run: runB } = await seedDocumentAndRun(candidate.id, projectB.id, userB.id);
    await seedAuthority(candidate.id, projectB.id, runB.id);

    const result = await computeLiveCandidateScore(prisma, candidate.id, projectA.id);
    expect(result.computable).toBe(true);
    if (result.computable) {
      expect(result.score).toBe(100);
    }
  });
});

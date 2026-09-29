import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@recruitment-platform/db";
import { resolveEligibleAssessments } from "../modules/assessments/eligibility.js";
import { resetDatabase, createUser } from "./test-utils.js";

/**
 * Gate 2 — dedicated tests for the additive Score Evidence Eligibility
 * helper (ratified decision paper, Items 1-26 + Final Synthesis). Tests
 * ONLY the predicate `resolveEligibleAssessments` implements:
 *
 *   assessment.processingRunId === candidate.currentProfileProcessingRunId
 *
 * scoped by the caller-supplied candidateId/projectId. Deliberately does
 * not assert on ProcessingRun.status, EvidenceStrength, AssessmentStatus,
 * AssessmentEvidence.role, requirement version, or HR decisions — none of
 * those are eligibility inputs, per the ratified rule.
 */
describe("resolveEligibleAssessments (Score Evidence Eligibility)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    // no per-test resource cleanup beyond resetDatabase in beforeEach
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedProject() {
    const email = `hr-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await createUser(email, "HR_USER");
    const project = await prisma.recruitmentProject.create({
      data: { title: "Eligibility Test Project", createdBy: user.id },
    });
    return { user, project };
  }

  async function seedCandidate() {
    return prisma.candidate.create({
      data: { fullName: "Test Candidate", email: "test@example.com" },
    });
  }

  async function seedRequirement(projectId: string) {
    return prisma.jobRequirement.create({
      data: {
        projectId,
        category: "FUNCTIONAL_EXPERIENCE",
        description: "Requirement for eligibility test",
        mandatory: false,
        status: "APPROVED",
        currentVersionNumber: 1,
        hrApprovedWeight: 100,
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
      data: {
        candidateDocumentId: document.id,
        attemptNumber: 1,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    return { document, run };
  }

  async function seedAssessment(params: {
    candidateId: string;
    projectId: string;
    requirementId: string;
    processingRunId: string;
  }) {
    return prisma.assessment.create({
      data: {
        candidateId: params.candidateId,
        projectId: params.projectId,
        requirementId: params.requirementId,
        processingRunId: params.processingRunId,
        aiAssessmentSummary: "Eligibility test assessment.",
        status: "INSUFFICIENT_EVIDENCE",
      },
    });
  }

  it("1. returns an eligible Assessment (matching processingRunId, candidateId, projectId)", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const requirement = await seedRequirement(project.id);
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { currentProfileProcessingRunId: run.id },
    });

    const assessment = await seedAssessment({
      candidateId: candidate.id,
      projectId: project.id,
      requirementId: requirement.id,
      processingRunId: run.id,
    });

    const result = await resolveEligibleAssessments(prisma, candidate.id, project.id);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(assessment.id);
  });

  it("2. excludes a non-authoritative Assessment (different processingRunId)", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const requirement = await seedRequirement(project.id);
    const { run: authoritativeRun } = await seedDocumentAndRun(candidate.id, project.id, user.id);
    const { run: otherRun } = await seedDocumentAndRun(candidate.id, project.id, user.id);

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { currentProfileProcessingRunId: authoritativeRun.id },
    });

    // Assessment belongs to a run other than the authoritative one.
    await seedAssessment({
      candidateId: candidate.id,
      projectId: project.id,
      requirementId: requirement.id,
      processingRunId: otherRun.id,
    });

    const result = await resolveEligibleAssessments(prisma, candidate.id, project.id);

    expect(result).toEqual([]);
  });

  it("3. returns [] when the candidate has no published profile (currentProfileProcessingRunId is NULL)", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const requirement = await seedRequirement(project.id);
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);

    // currentProfileProcessingRunId left NULL (never published).
    await seedAssessment({
      candidateId: candidate.id,
      projectId: project.id,
      requirementId: requirement.id,
      processingRunId: run.id,
    });

    const result = await resolveEligibleAssessments(prisma, candidate.id, project.id);

    expect(result).toEqual([]);
  });

  it("4. returns [] when the authoritative run has no matching Assessments", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { currentProfileProcessingRunId: run.id },
    });

    // No Assessment created for this run at all.
    const result = await resolveEligibleAssessments(prisma, candidate.id, project.id);

    expect(result).toEqual([]);
  });

  it("5. excludes an otherwise-matching Assessment scoped to a different projectId (query scoping only)", async () => {
    const { user, project: projectA } = await seedProject();
    const { project: projectB } = await seedProject();
    const candidate = await seedCandidate();
    const requirement = await seedRequirement(projectA.id);
    const { run } = await seedDocumentAndRun(candidate.id, projectA.id, user.id);

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { currentProfileProcessingRunId: run.id },
    });

    await seedAssessment({
      candidateId: candidate.id,
      projectId: projectA.id,
      requirementId: requirement.id,
      processingRunId: run.id,
    });

    // Query with projectB's id — the matching Assessment belongs to projectA.
    const result = await resolveEligibleAssessments(prisma, candidate.id, projectB.id);

    expect(result).toEqual([]);
  });

  it("6. predicate fidelity — eligibility is unaffected by AssessmentStatus, and no additional condition is applied", async () => {
    const { user, project } = await seedProject();
    const candidate = await seedCandidate();
    const requirement = await seedRequirement(project.id);
    const { run } = await seedDocumentAndRun(candidate.id, project.id, user.id);

    await prisma.candidate.update({
      where: { id: candidate.id },
      data: { currentProfileProcessingRunId: run.id },
    });

    // An Assessment with MANDATORY_GAP status and zero linked evidence —
    // per Items 12/25, neither AssessmentStatus nor evidence presence is
    // an eligibility input. It must still be returned.
    const assessment = await prisma.assessment.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        requirementId: requirement.id,
        processingRunId: run.id,
        aiAssessmentSummary: "No evidence found for this requirement.",
        status: "MANDATORY_GAP",
      },
    });

    const result = await resolveEligibleAssessments(prisma, candidate.id, project.id);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(assessment.id);
    expect(result[0].status).toBe("MANDATORY_GAP");
  });
});

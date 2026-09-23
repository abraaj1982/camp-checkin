import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@recruitment-platform/db";
import { createUser, resetDatabase } from "./test-utils.js";

/**
 * Phase 2 hardening, Sections 1 & 2: explicit Assessment<->Evidence
 * traceability, and a candidate with historical Evidence/Assessment/
 * HrDecision rows can never be hard-deleted by an ordinary candidate-
 * profile removal. No Phase 4 assessment engine exists yet — these tests
 * exercise the schema/model directly via Prisma, the way the (still
 * unbuilt) Phase 4 code eventually will.
 */
describe("Assessment <-> Evidence traceability and candidate retention safety", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedProjectRequirementCandidate() {
    const user = await createUser("hr@example.com", "HR_USER");
    const project = await prisma.recruitmentProject.create({
      data: { title: "HR Manager", createdBy: user.id },
    });
    const requirement = await prisma.jobRequirement.create({
      data: {
        projectId: project.id,
        category: "FUNCTIONAL_EXPERIENCE",
        description: "5 years Employee Relations",
        mandatory: true,
      },
    });
    const candidate = await prisma.candidate.create({ data: { fullName: "Jordan Doe" } });
    return { user, project, requirement, candidate };
  }

  it("links an assessment to multiple evidence rows with distinct roles (supporting vs. considered-and-rejected)", async () => {
    const { project, requirement, candidate } = await seedProjectRequirementCandidate();

    const strongEvidence = await prisma.evidence.create({
      data: {
        requirementId: requirement.id,
        candidateId: candidate.id,
        projectId: project.id,
        evidenceText: "Led grievance handling and disciplinary investigations for 200+ staff.",
        evidenceType: "DIRECT",
        evidenceStrength: "STRONG",
        confidence: "HIGH",
      },
    });
    const weakEvidence = await prisma.evidence.create({
      data: {
        requirementId: requirement.id,
        candidateId: candidate.id,
        projectId: project.id,
        evidenceText: "Assisted HR team with general administrative tasks.",
        evidenceType: "INFERRED",
        evidenceStrength: "WEAK",
        confidence: "LOW",
      },
    });

    const assessment = await prisma.assessment.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        requirementId: requirement.id,
        aiAssessmentSummary: "Strong direct evidence of employee relations casework.",
        status: "STRONG_EVIDENCE",
        evidenceLinks: {
          create: [
            { evidenceId: strongEvidence.id, role: "SUPPORTING", rationale: "Directly on-point." },
            {
              evidenceId: weakEvidence.id,
              role: "CONSIDERED_REJECTED",
              rationale: "Too generic to count as employee relations evidence.",
            },
          ],
        },
      },
      include: { evidenceLinks: { include: { evidence: true } } },
    });

    expect(assessment.evidenceLinks).toHaveLength(2);
    const supporting = assessment.evidenceLinks.find((l) => l.role === "SUPPORTING");
    const rejected = assessment.evidenceLinks.find((l) => l.role === "CONSIDERED_REJECTED");
    expect(supporting?.evidenceId).toBe(strongEvidence.id);
    expect(supporting?.evidence.sourcePage).toBe(strongEvidence.sourcePage);
    expect(rejected?.evidenceId).toBe(weakEvidence.id);
    expect(rejected?.rationale).toContain("Too generic");

    // Traceability back to the original document: sourceDocumentId +
    // sourcePage survive on Evidence regardless of AssessmentEvidence.
    expect(supporting?.evidence.evidenceText).toContain("grievance handling");
  });

  it("does not let matching candidateId+projectId+requirementId stand in for an explicit link", async () => {
    // Two assessments for the same candidate+project+requirement pairing
    // (e.g. a re-run) must not implicitly "share" evidence — only an
    // explicit AssessmentEvidence row establishes the link.
    const { project, requirement, candidate } = await seedProjectRequirementCandidate();

    const evidence = await prisma.evidence.create({
      data: {
        requirementId: requirement.id,
        candidateId: candidate.id,
        projectId: project.id,
        evidenceText: "Handled union negotiations.",
        evidenceType: "DIRECT",
        evidenceStrength: "STRONG",
        confidence: "HIGH",
      },
    });
    const assessmentA = await prisma.assessment.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        requirementId: requirement.id,
        aiAssessmentSummary: "First pass.",
        status: "STRONG_EVIDENCE",
        evidenceLinks: { create: [{ evidenceId: evidence.id, role: "SUPPORTING" }] },
      },
    });
    const assessmentB = await prisma.assessment.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        requirementId: requirement.id,
        aiAssessmentSummary: "Re-run after a requirement edit.",
        status: "STRONG_EVIDENCE",
      },
    });

    const linksForB = await prisma.assessmentEvidence.findMany({
      where: { assessmentId: assessmentB.id },
    });
    expect(linksForB).toHaveLength(0);

    const linksForA = await prisma.assessmentEvidence.findMany({
      where: { assessmentId: assessmentA.id },
    });
    expect(linksForA).toHaveLength(1);
  });

  it("refuses to hard-delete a candidate with historical Evidence rows", async () => {
    const { project, requirement, candidate } = await seedProjectRequirementCandidate();
    await prisma.evidence.create({
      data: {
        requirementId: requirement.id,
        candidateId: candidate.id,
        projectId: project.id,
        evidenceType: "DIRECT",
        evidenceStrength: "STRONG",
        confidence: "HIGH",
      },
    });

    await expect(prisma.candidate.delete({ where: { id: candidate.id } })).rejects.toThrow(
      Prisma.PrismaClientKnownRequestError,
    );

    const stillThere = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    expect(stillThere).not.toBeNull();
  });

  it("refuses to hard-delete a candidate with a historical Assessment row", async () => {
    const { project, requirement, candidate } = await seedProjectRequirementCandidate();
    await prisma.assessment.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        requirementId: requirement.id,
        aiAssessmentSummary: "Historical assessment.",
        status: "REVIEW_REQUIRED",
      },
    });

    await expect(prisma.candidate.delete({ where: { id: candidate.id } })).rejects.toThrow(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it("refuses to hard-delete a candidate with a historical HrDecision row", async () => {
    const { candidate, project } = await seedProjectRequirementCandidate();
    const user = await prisma.user.findFirstOrThrow();
    await prisma.hrDecision.create({
      data: { candidateId: candidate.id, projectId: project.id, decision: "SHORTLIST", decidedBy: user.id },
    });

    await expect(prisma.candidate.delete({ where: { id: candidate.id } })).rejects.toThrow(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it("still allows deleting a candidate with no history (profile-only removal)", async () => {
    const candidate = await prisma.candidate.create({ data: { fullName: "No History Yet" } });
    await prisma.candidateSkill.create({ data: { candidateId: candidate.id, skillName: "Excel" } });

    await expect(prisma.candidate.delete({ where: { id: candidate.id } })).resolves.toBeDefined();

    const gone = await prisma.candidate.findUnique({ where: { id: candidate.id } });
    expect(gone).toBeNull();
  });

  it("lets the original CV document be purged (SetNull) without touching the Evidence row that cites it", async () => {
    const { project, requirement, candidate } = await seedProjectRequirementCandidate();
    const user = await prisma.user.findFirstOrThrow();
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        fileType: "pdf",
        storageKey: "s3://bucket/key.pdf",
        originalFilename: "resume.pdf",
        uploadedBy: user.id,
      },
    });
    const evidence = await prisma.evidence.create({
      data: {
        requirementId: requirement.id,
        candidateId: candidate.id,
        projectId: project.id,
        sourceDocumentId: document.id,
        sourcePage: 2,
        evidenceText: "Preserved quote, independent of the original file.",
        evidenceType: "DIRECT",
        evidenceStrength: "STRONG",
        confidence: "HIGH",
      },
    });

    await prisma.candidateDocument.delete({ where: { id: document.id } });

    const survivingEvidence = await prisma.evidence.findUnique({ where: { id: evidence.id } });
    expect(survivingEvidence).not.toBeNull();
    expect(survivingEvidence?.sourceDocumentId).toBeNull();
    expect(survivingEvidence?.evidenceText).toBe("Preserved quote, independent of the original file.");
    expect(survivingEvidence?.sourcePage).toBe(2);
  });
});

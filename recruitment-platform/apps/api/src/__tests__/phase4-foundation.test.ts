import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@recruitment-platform/db";
import { createUser, resetDatabase } from "./test-utils.js";

/**
 * Phase 4 foundation decisions, verified directly against the schema (no
 * Phase 4 intelligence code exists yet — that's the point of this pass:
 * establish and prove the data-model foundation before building on it).
 */
describe("Phase 4 foundation: evidence traceability, career-consistency findings, requirement deletion protection", () => {
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

  /** Every Assessment now requires a ProcessingRun (Phase 4A) — seed a minimal one directly via Prisma. */
  async function seedProcessingRun(candidateId: string, projectId: string, uploadedBy: string) {
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId,
        projectId,
        fileType: "pdf",
        storageKey: "s3://bucket/key.pdf",
        originalFilename: "resume.pdf",
        uploadedBy,
      },
    });
    return prisma.processingRun.create({ data: { candidateDocumentId: document.id, attemptNumber: 1, status: "RUNNING" } });
  }

  describe("Decision 1 — multiple evidence candidates persisted with SUPPORTING/CONSIDERED_REJECTED roles", () => {
    it("persists several SUPPORTING and CONSIDERED_REJECTED evidence rows for one requirement, all linked to one deterministic Assessment", async () => {
      const { project, requirement, candidate } = await seedProjectRequirementCandidate();

      // Two SUPPORTING quotes and one CONSIDERED_REJECTED quote for the SAME
      // requirement — exactly the shape Decision 1 requires and the old
      // one-item-per-requirement schema couldn't express.
      const strongEvidence = await prisma.evidence.create({
        data: {
          requirementId: requirement.id,
          candidateId: candidate.id,
          projectId: project.id,
          evidenceText: "Led grievance handling for 200+ staff.",
          sourcePage: 2,
          evidenceType: "DIRECT",
          evidenceStrength: "STRONG",
          confidence: "HIGH",
        },
      });
      const moderateEvidence = await prisma.evidence.create({
        data: {
          requirementId: requirement.id,
          candidateId: candidate.id,
          projectId: project.id,
          evidenceText: "Conducted disciplinary investigations across two regions.",
          sourcePage: 3,
          evidenceType: "DIRECT",
          evidenceStrength: "MODERATE",
          confidence: "MEDIUM",
        },
      });
      const rejectedEvidence = await prisma.evidence.create({
        data: {
          requirementId: requirement.id,
          candidateId: candidate.id,
          projectId: project.id,
          evidenceText: "Assisted with general HR administration.",
          sourcePage: 1,
          evidenceType: "INFERRED",
          evidenceStrength: "WEAK",
          confidence: "LOW",
        },
      });

      // The deterministic assessment result — computed by application logic
      // from the evidence above, never assigned by the AI directly (Decision 1).
      const run = await seedProcessingRun(candidate.id, project.id, (await prisma.user.findFirstOrThrow()).id);
      const assessment = await prisma.assessment.create({
        data: {
          candidateId: candidate.id,
          projectId: project.id,
          requirementId: requirement.id,
          processingRunId: run.id,
          aiAssessmentSummary: "Strong direct evidence across two supporting quotes.",
          status: "STRONG_EVIDENCE",
          evidenceLinks: {
            create: [
              { evidenceId: strongEvidence.id, role: "SUPPORTING", rationale: "Directly on-point." },
              { evidenceId: moderateEvidence.id, role: "SUPPORTING", rationale: "Corroborating detail." },
              {
                evidenceId: rejectedEvidence.id,
                role: "CONSIDERED_REJECTED",
                rationale: "Too generic to count as employee relations specifically.",
              },
            ],
          },
        },
        include: { evidenceLinks: true },
      });

      expect(assessment.evidenceLinks).toHaveLength(3);
      const supporting = assessment.evidenceLinks.filter((l) => l.role === "SUPPORTING");
      const rejected = assessment.evidenceLinks.filter((l) => l.role === "CONSIDERED_REJECTED");
      expect(supporting.map((l) => l.evidenceId).sort()).toEqual(
        [strongEvidence.id, moderateEvidence.id].sort(),
      );
      expect(rejected.map((l) => l.evidenceId)).toEqual([rejectedEvidence.id]);
    });

    it("traces every persisted evidence row back to Requirement -> Assessment -> source document/page", async () => {
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
          sourcePage: 4,
          evidenceText: "Led grievance handling.",
          evidenceType: "DIRECT",
          evidenceStrength: "STRONG",
          confidence: "HIGH",
        },
      });
      const run = await seedProcessingRun(candidate.id, project.id, user.id);
      const assessment = await prisma.assessment.create({
        data: {
          candidateId: candidate.id,
          projectId: project.id,
          requirementId: requirement.id,
          processingRunId: run.id,
          aiAssessmentSummary: "Strong evidence.",
          status: "STRONG_EVIDENCE",
          evidenceLinks: { create: [{ evidenceId: evidence.id, role: "SUPPORTING" }] },
        },
        include: {
          requirement: true,
          evidenceLinks: { include: { evidence: { include: { sourceDocument: true } } } },
        },
      });

      // The full chain, walked from Assessment down to the original file.
      expect(assessment.requirement.id).toBe(requirement.id);
      const link = assessment.evidenceLinks[0];
      expect(link.evidence.requirementId).toBe(requirement.id);
      expect(link.evidence.sourcePage).toBe(4);
      expect(link.evidence.sourceDocument?.id).toBe(document.id);
      expect(link.evidence.sourceDocument?.originalFilename).toBe("resume.pdf");
    });
  });

  describe("Decision 2 — CandidateConsistencyFinding stays separate from Requirement Evidence and carries its own traceability", () => {
    it("persists a finding with a full source document/page/quote trail", async () => {
      const { project, candidate } = await seedProjectRequirementCandidate();
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

      const finding = await prisma.candidateConsistencyFinding.create({
        data: {
          candidateId: candidate.id,
          projectId: project.id,
          findingType: "UNCLEAR_CHRONOLOGY",
          severity: "VERIFICATION_REQUIRED",
          description: "Two roles listed with overlapping end/start months.",
          sourceDocumentId: document.id,
          sourcePage: 2,
          evidenceText: "HR Officer, Acme (2019-2021); HR Supervisor, Acme (2020-2022).",
          confidence: "MEDIUM",
        },
      });

      expect(finding.findingType).toBe("UNCLEAR_CHRONOLOGY");
      expect(finding.severity).toBe("VERIFICATION_REQUIRED");
      expect(finding.sourceDocumentId).toBe(document.id);

      const reread = await prisma.candidateConsistencyFinding.findUniqueOrThrow({
        where: { id: finding.id },
        include: { sourceDocument: true, candidate: true },
      });
      expect(reread.sourceDocument?.originalFilename).toBe("resume.pdf");
      expect(reread.candidate.id).toBe(candidate.id);
    });

    it("allows a date-math-only finding (no single quote) with null document/page/text, still carrying a description and confidence", async () => {
      const { project, candidate } = await seedProjectRequirementCandidate();

      const finding = await prisma.candidateConsistencyFinding.create({
        data: {
          candidateId: candidate.id,
          projectId: project.id,
          findingType: "EMPLOYMENT_GAP",
          severity: "INFORMATION_UNCLEAR",
          description: "Approximately 8-month gap between the two most recent roles.",
          confidence: "MEDIUM",
        },
      });

      expect(finding.sourceDocumentId).toBeNull();
      expect(finding.sourcePage).toBeNull();
      expect(finding.evidenceText).toBeNull();
    });

    it("keeps CandidateConsistencyFinding conceptually separate from Evidence/AssessmentEvidence — no shared rows", async () => {
      const { project, requirement, candidate } = await seedProjectRequirementCandidate();

      await prisma.candidateConsistencyFinding.create({
        data: {
          candidateId: candidate.id,
          projectId: project.id,
          findingType: "OVERLAPPING_DATES",
          severity: "POTENTIAL_INCONSISTENCY",
          description: "Overlapping employment dates.",
          confidence: "LOW",
        },
      });
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

      // Two entirely separate tables, not a shared "generic finding" row —
      // a consistency finding never becomes Requirement Evidence.
      const findings = await prisma.candidateConsistencyFinding.findMany({ where: { candidateId: candidate.id } });
      const evidence = await prisma.evidence.findMany({ where: { candidateId: candidate.id } });
      expect(findings).toHaveLength(1);
      expect(evidence).toHaveLength(1);
      expect(findings[0].id).not.toBe(evidence[0].id);
    });

    it("survives the original CV document being purged (SetNull), matching Evidence's retention behavior", async () => {
      const { project, candidate } = await seedProjectRequirementCandidate();
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
      const finding = await prisma.candidateConsistencyFinding.create({
        data: {
          candidateId: candidate.id,
          projectId: project.id,
          findingType: "EMPLOYMENT_GAP",
          severity: "INFORMATION_UNCLEAR",
          description: "Gap in employment history.",
          sourceDocumentId: document.id,
          sourcePage: 1,
          evidenceText: "Preserved quote.",
          confidence: "MEDIUM",
        },
      });

      await prisma.candidateDocument.delete({ where: { id: document.id } });

      const surviving = await prisma.candidateConsistencyFinding.findUniqueOrThrow({ where: { id: finding.id } });
      expect(surviving.sourceDocumentId).toBeNull();
      expect(surviving.evidenceText).toBe("Preserved quote."); // the finding's own text survives independently
    });
  });

  describe("Decision 4 — JobRequirement deletion protection", () => {
    it("refuses to hard-delete a JobRequirement with historical Evidence", async () => {
      const { requirement, candidate, project } = await seedProjectRequirementCandidate();
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

      await expect(prisma.jobRequirement.delete({ where: { id: requirement.id } })).rejects.toThrow(
        Prisma.PrismaClientKnownRequestError,
      );
      const stillThere = await prisma.jobRequirement.findUnique({ where: { id: requirement.id } });
      expect(stillThere).not.toBeNull();
    });

    it("refuses to hard-delete a JobRequirement with a historical Assessment", async () => {
      const { requirement, candidate, project } = await seedProjectRequirementCandidate();
      const run = await seedProcessingRun(candidate.id, project.id, (await prisma.user.findFirstOrThrow()).id);
      await prisma.assessment.create({
        data: {
          candidateId: candidate.id,
          projectId: project.id,
          requirementId: requirement.id,
          processingRunId: run.id,
          aiAssessmentSummary: "Summary.",
          status: "REVIEW_REQUIRED",
        },
      });

      await expect(prisma.jobRequirement.delete({ where: { id: requirement.id } })).rejects.toThrow(
        Prisma.PrismaClientKnownRequestError,
      );
    });

    it("still allows deleting a JobRequirement with no Evidence/Assessment history", async () => {
      const { requirement } = await seedProjectRequirementCandidate();
      await expect(prisma.jobRequirement.delete({ where: { id: requirement.id } })).resolves.toBeDefined();
    });
  });
});

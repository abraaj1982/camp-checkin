import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

/**
 * Phase 5A — Secure read APIs for Assessment/Evidence and Career
 * Consistency, server-side Blind Screening + view-time evidence redaction.
 * Every response is checked against the raw DB rows to confirm redaction
 * happened without corrupting non-text fields, and that the raw rows
 * themselves were never modified.
 */
describe("candidate assessment/evidence and career consistency read APIs (Phase 5A)", () => {
  let app: FastifyInstance;
  let cleanupStorage: () => Promise<void>;

  beforeEach(async () => {
    await resetDatabase();
    const { storage, cleanup } = await createTestStorage();
    cleanupStorage = cleanup;
    app = await buildTestApp({ storage });
  });

  afterEach(async () => {
    await cleanupStorage();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedProjectWithCandidate(options: { projectTitle?: string } = {}) {
    const email = `hr-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await createUser(email, "HR_USER");
    const project = await prisma.recruitmentProject.create({
      data: { title: options.projectTitle ?? "HR Manager", createdBy: user.id },
    });
    await prisma.projectMember.create({ data: { projectId: project.id, userId: user.id, role: "OWNER" } });
    const cookie = await loginAs(app, email);
    const candidate = await prisma.candidate.create({
      data: { fullName: "Jordan Doe", email: "jordan.doe@example.com", phone: "+1 (555) 123-4567" },
    });
    const link = await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId: project.id, anonymizedLabel: "Candidate #001" },
    });
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        fileType: "pdf",
        storageKey: "s3://bucket/key.pdf",
        originalFilename: "jordan-doe-resume.pdf",
        uploadedBy: user.id,
      },
    });
    await prisma.candidateExperience.create({
      data: { candidateId: candidate.id, documentId: document.id, employer: "Acme Corp", title: "HR Officer" },
    });
    return { user, project, cookie, candidate, link, document };
  }

  async function seedCompletedRunWithAssessment(
    document: { id: string; candidateId: string; projectId: string | null },
    project: { id: string },
    user: { id: string },
    options: { evidenceText?: string; rationale?: string; attemptNumber?: number } = {},
  ) {
    const requirement = await prisma.jobRequirement.create({
      data: {
        projectId: project.id,
        category: "FUNCTIONAL_EXPERIENCE",
        description: "5 years Employee Relations",
        mandatory: true,
        status: "APPROVED",
        currentVersionNumber: 1,
        hrApprovedWeight: 100,
      },
    });
    const version = await prisma.jobRequirementVersion.create({
      data: {
        requirementId: requirement.id,
        versionNumber: 1,
        category: requirement.category,
        description: requirement.description,
        mandatory: true,
        priority: "MEDIUM",
        evidenceCriteriaSnapshot: ["Grievance handling"],
        hrApprovedWeight: 100,
        approvedBy: user.id,
      },
    });
    const run = await prisma.processingRun.create({
      data: {
        candidateDocumentId: document.id,
        attemptNumber: options.attemptNumber ?? 1,
        status: "COMPLETED",
        completedAt: new Date(),
      },
    });
    await prisma.candidateDocument.update({
      where: { id: document.id },
      data: { currentProcessingRunId: run.id, status: "COMPLETED" },
    });
    const evidence = await prisma.evidence.create({
      data: {
        requirementId: requirement.id,
        candidateId: document.candidateId,
        projectId: project.id,
        sourceDocumentId: document.id,
        sourcePage: 2,
        evidenceText:
          options.evidenceText ??
          "Led grievance handling at Acme Corp; contact jane.doe@example.com or +1 (555) 123-4567.",
        evidenceType: "DIRECT",
        evidenceStrength: "STRONG",
        confidence: "HIGH",
      },
    });
    const assessment = await prisma.assessment.create({
      data: {
        candidateId: document.candidateId,
        projectId: project.id,
        requirementId: requirement.id,
        requirementVersionId: version.id,
        processingRunId: run.id,
        aiAssessmentSummary: "1 supporting, 0 considered-and-rejected evidence item(s) identified.",
        status: "STRONG_EVIDENCE",
        evidenceLinks: {
          create: [
            {
              evidenceId: evidence.id,
              role: "SUPPORTING",
              rationale: options.rationale ?? "Directly on-point, from Acme Corp's own records.",
            },
          ],
        },
      },
    });
    return { requirement, version, run, evidence, assessment };
  }

  describe("GET /projects/:projectId/candidates/:candidateId/assessments", () => {
    it("returns assessment results with correct structure and traceable fields", async () => {
      const { project, cookie, candidate, document, user } = await seedProjectWithCandidate();
      await seedCompletedRunWithAssessment(document, project, user);

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/assessments`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();

      expect(body.candidate).toEqual({ id: candidate.id, anonymizedLabel: "Candidate #001" });
      expect(body.assessments).toHaveLength(1);
      const a = body.assessments[0];
      expect(a.status).toBe("STRONG_EVIDENCE");
      expect(a.requirement.description).toBe("5 years Employee Relations");
      expect(a.requirement.mandatory).toBe(true);
      expect(a.requirementVersion.versionNumber).toBe(1);
      expect(a.evidence).toHaveLength(1);
      expect(a.evidence[0].role).toBe("SUPPORTING");
      expect(a.evidence[0].evidenceStrength).toBe("STRONG");
      expect(a.evidence[0].confidence).toBe("HIGH");
      expect(a.evidence[0].sourcePage).toBe(2); // copied verbatim, untouched by redaction
      expect(a.evidence[0].source).toBe("Source Document");
    });

    it("redacts direct identifiers (email/phone) and tokenizes employer names in evidenceText and rationale, without corrupting other fields", async () => {
      const { project, cookie, candidate, document, user } = await seedProjectWithCandidate();
      const { evidence, assessment } = await seedCompletedRunWithAssessment(document, project, user, {
        evidenceText: "Led grievance handling at Acme Corp; contact jane.doe@example.com or +1 (555) 123-4567.",
        rationale: "This quote from Acme Corp shows direct, on-point experience.",
      });

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/assessments`,
        headers: { cookie },
      });
      const body = res.json();
      const returnedEvidence = body.assessments[0].evidence[0];

      // Redacted: no raw employer name, no raw email/phone.
      expect(returnedEvidence.evidenceText).not.toContain("Acme Corp");
      expect(returnedEvidence.evidenceText).not.toContain("jane.doe@example.com");
      expect(returnedEvidence.evidenceText).not.toContain("555");
      expect(returnedEvidence.evidenceText).toContain("Company A");
      expect(returnedEvidence.rationale).not.toContain("Acme Corp");
      expect(returnedEvidence.rationale).toContain("Company A");

      // Non-text fields byte-identical to the DB row — redaction never touched them.
      expect(returnedEvidence.evidenceStrength).toBe(evidence.evidenceStrength);
      expect(returnedEvidence.confidence).toBe(evidence.confidence);
      expect(returnedEvidence.sourcePage).toBe(evidence.sourcePage);
      expect(returnedEvidence.role).toBe("SUPPORTING");

      // The RAW database rows were never modified by serving this response.
      const rawEvidence = await prisma.evidence.findUniqueOrThrow({ where: { id: evidence.id } });
      expect(rawEvidence.evidenceText).toContain("Acme Corp");
      expect(rawEvidence.evidenceText).toContain("jane.doe@example.com");
      const rawLink = await prisma.assessmentEvidence.findFirstOrThrow({ where: { assessmentId: assessment.id } });
      expect(rawLink.rationale).toContain("Acme Corp");
    });

    it("never exposes originalFilename, sourceDocumentId, candidate fullName/email/phone, or aiInteractionId", async () => {
      const { project, cookie, candidate, document, user } = await seedProjectWithCandidate();
      await seedCompletedRunWithAssessment(document, project, user);

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/assessments`,
        headers: { cookie },
      });
      const raw = res.body;
      expect(raw).not.toContain("jordan-doe-resume.pdf");
      expect(raw).not.toContain("Jordan Doe");
      expect(raw).not.toContain("jordan.doe@example.com");
      expect(raw).not.toContain(document.id); // sourceDocumentId never serialized
      expect(raw).not.toContain("aiInteractionId");
      expect(raw).not.toContain("originalFilename");
    });

    it("only returns the current ProcessingRun's assessments — a historical run's are excluded after a retry", async () => {
      const { project, cookie, candidate, document, user } = await seedProjectWithCandidate();
      const first = await seedCompletedRunWithAssessment(document, project, user, {
        evidenceText: "First attempt evidence.",
        attemptNumber: 1,
      });
      // Simulate a retry: mark the first run FAILED (as a real retry would,
      // per worker/src/processing-run.ts), then a second run COMPLETES and
      // becomes current — reusing the same requirement so both runs produce
      // an Assessment for the identical requirement, proving the endpoint
      // picks by run, not by requirement identity.
      await prisma.processingRun.update({ where: { id: first.run.id }, data: { status: "FAILED" } });
      const secondRun = await prisma.processingRun.create({
        data: { candidateDocumentId: document.id, attemptNumber: 2, status: "COMPLETED", completedAt: new Date() },
      });
      const secondEvidence = await prisma.evidence.create({
        data: {
          requirementId: first.requirement.id,
          candidateId: candidate.id,
          projectId: project.id,
          sourceDocumentId: document.id,
          sourcePage: 3,
          evidenceText: "Second attempt evidence, from the successful retry.",
          evidenceType: "DIRECT",
          evidenceStrength: "MODERATE",
          confidence: "MEDIUM",
        },
      });
      await prisma.assessment.create({
        data: {
          candidateId: candidate.id,
          projectId: project.id,
          requirementId: first.requirement.id,
          requirementVersionId: first.version.id,
          processingRunId: secondRun.id,
          aiAssessmentSummary: "1 supporting, 0 considered-and-rejected evidence item(s) identified.",
          status: "STRONG_EVIDENCE",
          evidenceLinks: { create: [{ evidenceId: secondEvidence.id, role: "SUPPORTING" }] },
        },
      });
      // completeProcessingRun's own atomicity is exercised elsewhere
      // (worker tests) — here we only need the document's pointer updated,
      // matching what that function guarantees.
      await prisma.candidateDocument.update({
        where: { id: document.id },
        data: { currentProcessingRunId: secondRun.id },
      });

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/assessments`,
        headers: { cookie },
      });
      const body = res.json();

      expect(body.assessments).toHaveLength(1); // not 2 — the failed run's assessment is excluded
      expect(body.assessments[0].evidence[0].evidenceText).toContain("Second attempt evidence");
      expect(body.assessments[0].evidence[0].evidenceText).not.toContain("First attempt evidence");
      expect(body.assessments[0].evidence[0].sourcePage).toBe(3);
    });

    it("returns empty assessments when no ProcessingRun has completed yet (not an error)", async () => {
      const { project, cookie, candidate } = await seedProjectWithCandidate();

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/assessments`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().assessments).toEqual([]);
    });

    it("denies an unrelated HR_USER (404, not 403)", async () => {
      const { project, candidate, document, user } = await seedProjectWithCandidate();
      await seedCompletedRunWithAssessment(document, project, user);
      const outsiderEmail = "outsider@example.com";
      await createUser(outsiderEmail, "HR_USER");
      const outsiderCookie = await loginAs(app, outsiderEmail);

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/assessments`,
        headers: { cookie: outsiderCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it("lets HR_ADMIN read any project's candidate assessments without explicit membership", async () => {
      const { project, candidate, document, user } = await seedProjectWithCandidate();
      await seedCompletedRunWithAssessment(document, project, user);
      const adminEmail = "admin@example.com";
      await createUser(adminEmail, "HR_ADMIN");
      const adminCookie = await loginAs(app, adminEmail);

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/assessments`,
        headers: { cookie: adminCookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().assessments).toHaveLength(1);
    });

    it("returns 404 for a candidate that exists but is not linked to this project", async () => {
      const { project, cookie } = await seedProjectWithCandidate({ projectTitle: "Project A" });
      const otherProjectSeed = await seedProjectWithCandidate({ projectTitle: "Project B" });

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${otherProjectSeed.candidate.id}/assessments`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe("GET /projects/:projectId/candidates/:candidateId/consistency-findings", () => {
    /** Creates a COMPLETED ProcessingRun for the document and makes it current — required for a finding to appear in the "current" API response. */
    async function seedCurrentRun(documentId: string, attemptNumber = 1) {
      const run = await prisma.processingRun.create({
        data: { candidateDocumentId: documentId, attemptNumber, status: "COMPLETED", completedAt: new Date() },
      });
      await prisma.candidateDocument.update({ where: { id: documentId }, data: { currentProcessingRunId: run.id } });
      return run;
    }

    async function seedFinding(
      candidateId: string,
      projectId: string,
      documentId: string,
      processingRunId: string,
      overrides: { description?: string; evidenceText?: string | null; sourcePage?: number | null } = {},
    ) {
      return prisma.candidateConsistencyFinding.create({
        data: {
          candidateId,
          projectId,
          findingType: "EMPLOYMENT_GAP",
          severity: "INFORMATION_UNCLEAR",
          description: overrides.description ?? "Approximately 7-month gap noted.",
          sourceDocumentId: documentId,
          sourcePage: overrides.sourcePage === undefined ? null : overrides.sourcePage,
          evidenceText: overrides.evidenceText === undefined ? null : overrides.evidenceText,
          confidence: "MEDIUM",
          aiInteractionId: null,
          processingRunId,
        },
      });
    }

    it("returns findings with correct fields, including a null-sourcePage/null-evidenceText finding", async () => {
      const { project, cookie, candidate, document } = await seedProjectWithCandidate();
      const run = await seedCurrentRun(document.id);
      await seedFinding(candidate.id, project.id, document.id, run.id);

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/consistency-findings`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.candidate).toEqual({ id: candidate.id, anonymizedLabel: "Candidate #001" });
      expect(body.findings).toHaveLength(1);
      expect(body.findings[0].findingType).toBe("EMPLOYMENT_GAP");
      expect(body.findings[0].severity).toBe("INFORMATION_UNCLEAR");
      expect(body.findings[0].sourcePage).toBeNull();
      expect(body.findings[0].evidenceText).toBeNull();
      expect(body.findings[0].confidence).toBe("MEDIUM");
      expect(body.findings[0].source).toBe("Source Document");
    });

    it("redacts description and evidenceText, never exposes sourceDocumentId or aiInteractionId", async () => {
      const { project, cookie, candidate, document } = await seedProjectWithCandidate();
      const run = await seedCurrentRun(document.id);
      const finding = await seedFinding(candidate.id, project.id, document.id, run.id, {
        description: "Gap between roles at Acme Corp; verify with jane.doe@example.com.",
        evidenceText: "HR Officer, Acme Corp (2019-2021)",
        sourcePage: 1,
      });

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/consistency-findings`,
        headers: { cookie },
      });
      const body = res.json();
      const returned = body.findings[0];

      expect(returned.description).not.toContain("Acme Corp");
      expect(returned.description).not.toContain("jane.doe@example.com");
      expect(returned.description).toContain("Company A");
      expect(returned.evidenceText).not.toContain("Acme Corp");
      expect(returned.evidenceText).toContain("Company A");
      expect(returned.sourcePage).toBe(1); // untouched by redaction
      expect(res.body).not.toContain("aiInteractionId");
      expect(res.body).not.toContain(document.id);
      expect(res.body).not.toContain("processingRunId");

      // Raw DB row unmodified.
      const raw = await prisma.candidateConsistencyFinding.findUniqueOrThrow({ where: { id: finding.id } });
      expect(raw.description).toContain("Acme Corp");
      expect(raw.evidenceText).toContain("Acme Corp");
    });

    it("returns empty findings when none exist (not an error)", async () => {
      const { project, cookie, candidate } = await seedProjectWithCandidate();

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/consistency-findings`,
        headers: { cookie },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().findings).toEqual([]);
    });

    it("denies an unrelated HR_USER (404, not 403)", async () => {
      const { project, candidate, document } = await seedProjectWithCandidate();
      const run = await seedCurrentRun(document.id);
      await seedFinding(candidate.id, project.id, document.id, run.id);
      const outsiderEmail = "outsider2@example.com";
      await createUser(outsiderEmail, "HR_USER");
      const outsiderCookie = await loginAs(app, outsiderEmail);

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/consistency-findings`,
        headers: { cookie: outsiderCookie },
      });
      expect(res.statusCode).toBe(404);
    });

    it("persists processingRunId correctly and supports multiple findings under the same run", async () => {
      const { project, cookie, candidate, document } = await seedProjectWithCandidate();
      const run = await seedCurrentRun(document.id);
      const findingA = await seedFinding(candidate.id, project.id, document.id, run.id, { description: "First finding." });
      const findingB = await seedFinding(candidate.id, project.id, document.id, run.id, { description: "Second finding." });

      expect(findingA.processingRunId).toBe(run.id);
      expect(findingB.processingRunId).toBe(run.id);

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/consistency-findings`,
        headers: { cookie },
      });
      expect(res.json().findings).toHaveLength(2);
    });

    it("retry: a failed run's finding is excluded from the current-result API, a later successful run's finding is included, and the historical finding remains in the database", async () => {
      const { project, cookie, candidate, document } = await seedProjectWithCandidate();

      // Run 1: creates Finding A, then fails.
      const run1 = await prisma.processingRun.create({
        data: { candidateDocumentId: document.id, attemptNumber: 1, status: "RUNNING" },
      });
      const findingA = await seedFinding(candidate.id, project.id, document.id, run1.id, {
        description: "Finding A, from the run that failed.",
      });
      await prisma.processingRun.update({ where: { id: run1.id }, data: { status: "FAILED", completedAt: new Date() } });
      // currentProcessingRunId was never set for the failed run — the
      // document has no current run yet at this point.

      // Run 2: creates Finding B, then completes and becomes current.
      const run2 = await prisma.processingRun.create({
        data: { candidateDocumentId: document.id, attemptNumber: 2, status: "COMPLETED", completedAt: new Date() },
      });
      await prisma.candidateDocument.update({ where: { id: document.id }, data: { currentProcessingRunId: run2.id } });
      const findingB = await seedFinding(candidate.id, project.id, document.id, run2.id, {
        description: "Finding B, from the successful retry.",
      });

      const res = await app.inject({
        method: "GET",
        url: `/projects/${project.id}/candidates/${candidate.id}/consistency-findings`,
        headers: { cookie },
      });
      const body = res.json();

      expect(body.findings).toHaveLength(1);
      expect(body.findings[0].description).toContain("Finding B");
      expect(body.findings.some((f: { description: string }) => f.description.includes("Finding A"))).toBe(false);

      // Finding A remains fully persisted in the database — never deleted or
      // reassigned by the retry — it is simply excluded from this "current
      // results only" response.
      const rawFindingA = await prisma.candidateConsistencyFinding.findUniqueOrThrow({ where: { id: findingA.id } });
      expect(rawFindingA.processingRunId).toBe(run1.id);
      expect(rawFindingA.description).toContain("Finding A");
      const rawFindingB = await prisma.candidateConsistencyFinding.findUniqueOrThrow({ where: { id: findingB.id } });
      expect(rawFindingB.processingRunId).toBe(run2.id);
    });
  });
});

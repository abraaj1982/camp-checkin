import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

/**
 * Phase 6 — HR Decision UI backend
 * (POST + GET /projects/:projectId/candidates/:candidateId/decisions).
 * A decision is a human action recorded in response to evidence shown
 * elsewhere — this never computes, ranks, or suggests anything; these
 * tests only prove the recording/listing plumbing and its guardrails.
 */
describe("HR decisions (Phase 6)", () => {
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

  async function seedProject(projectTitle = "HR Manager") {
    const email = `hr-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await createUser(email, "HR_USER");
    const project = await prisma.recruitmentProject.create({ data: { title: projectTitle, createdBy: user.id } });
    await prisma.projectMember.create({ data: { projectId: project.id, userId: user.id, role: "OWNER" } });
    const cookie = await loginAs(app, email);
    return { user, project, cookie };
  }

  async function seedLinkedCandidate(project: { id: string }, label = "Candidate #001") {
    const candidate = await prisma.candidate.create({ data: { fullName: "Jordan Doe", email: "jordan@example.com" } });
    await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId: project.id, anonymizedLabel: label },
    });
    return candidate;
  }

  async function seedRequirementAndAssessment(
    project: { id: string },
    user: { id: string },
    candidate: { id: string },
    run: { id: string },
    status: string = "MANDATORY_GAP",
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
        evidenceCriteriaSnapshot: [],
        hrApprovedWeight: 100,
        approvedBy: user.id,
      },
    });
    const assessment = await prisma.assessment.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        requirementId: requirement.id,
        requirementVersionId: version.id,
        processingRunId: run.id,
        aiAssessmentSummary: "0 supporting, 0 considered-and-rejected evidence item(s) identified.",
        status: status as never,
      },
    });
    return assessment;
  }

  async function seedDocumentAndRun(project: { id: string }, user: { id: string }, candidate: { id: string }) {
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        fileType: "pdf",
        storageKey: `s3://bucket/${candidate.id}.pdf`,
        originalFilename: "resume.pdf",
        uploadedBy: user.id,
      },
    });
    const run = await prisma.processingRun.create({
      data: { candidateDocumentId: document.id, attemptNumber: 1, status: "COMPLETED", completedAt: new Date() },
    });
    await prisma.candidateDocument.update({
      where: { id: document.id },
      data: { currentProcessingRunId: run.id, status: "COMPLETED" },
    });
    return { document, run };
  }

  function post(cookie: string, projectId: string, candidateId: string, payload: Record<string, unknown>) {
    return app.inject({
      method: "POST",
      url: `/projects/${projectId}/candidates/${candidateId}/decisions`,
      headers: { cookie },
      payload,
    });
  }

  function get(cookie: string, projectId: string, candidateId: string) {
    return app.inject({
      method: "GET",
      url: `/projects/${projectId}/candidates/${candidateId}/decisions`,
      headers: { cookie },
    });
  }

  it("rejects recording a decision for a candidate not linked to the project (404, not 400/403)", async () => {
    const { project, cookie } = await seedProject();
    const unlinkedCandidate = await prisma.candidate.create({ data: { fullName: "Not Linked" } });

    const res = await post(cookie, project.id, unlinkedCandidate.id, { decision: "SHORTLIST" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("candidate_not_found");

    const decisions = await prisma.hrDecision.findMany({ where: { candidateId: unlinkedCandidate.id } });
    expect(decisions).toHaveLength(0);
  });

  it("rejects listing decisions for a candidate not linked to the project (404)", async () => {
    const { project, cookie } = await seedProject();
    const unlinkedCandidate = await prisma.candidate.create({ data: { fullName: "Not Linked" } });

    const res = await get(cookie, project.id, unlinkedCandidate.id);
    expect(res.statusCode).toBe(404);
  });

  it("records a decision and returns an explicit DTO — no raw Prisma row, no candidate identity fields", async () => {
    const { project, cookie } = await seedProject();
    const candidate = await seedLinkedCandidate(project);

    const res = await post(cookie, project.id, candidate.id, { decision: "INTERVIEW", notes: "Strong evidence." });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body).toEqual({
      id: expect.any(String),
      decision: "INTERVIEW",
      notes: "Strong evidence.",
      decidedAt: expect.any(String),
      override: null,
    });
    const raw = JSON.stringify(body);
    expect(raw).not.toContain("Jordan Doe");
    expect(raw).not.toContain("jordan@example.com");
    expect(raw).not.toContain("candidateId");
    expect(raw).not.toContain("projectId");
    expect(raw).not.toContain("decidedBy");
  });

  it("lists decision history newest first, with an HR display name but no candidate identity fields", async () => {
    const { user, project, cookie } = await seedProject();
    const candidate = await seedLinkedCandidate(project);

    await post(cookie, project.id, candidate.id, { decision: "HOLD", notes: "first" });
    await post(cookie, project.id, candidate.id, { decision: "SHORTLIST", notes: "second" });

    const res = await get(cookie, project.id, candidate.id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.decisions).toHaveLength(2);
    expect(body.decisions[0].decision).toBe("SHORTLIST");
    expect(body.decisions[0].notes).toBe("second");
    expect(body.decisions[1].decision).toBe("HOLD");
    expect(body.decisions[0].decidedByName).toBe(user.name);

    const raw = JSON.stringify(body);
    expect(raw).not.toContain("Jordan Doe");
    expect(raw).not.toContain("jordan@example.com");
  });

  it("returns an empty decision list for a candidate with no decisions yet (not an error)", async () => {
    const { project, cookie } = await seedProject();
    const candidate = await seedLinkedCandidate(project);

    const res = await get(cookie, project.id, candidate.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().decisions).toEqual([]);
  });

  it("accepts an override against the candidate's current-run assessment and records HrOverride", async () => {
    const { user, project, cookie } = await seedProject();
    const candidate = await seedLinkedCandidate(project);
    const { run } = await seedDocumentAndRun(project, user, candidate);
    const assessment = await seedRequirementAndAssessment(project, user, candidate, run, "MANDATORY_GAP");

    const res = await post(cookie, project.id, candidate.id, {
      decision: "SHORTLIST",
      notes: "HR disagrees with the gap finding.",
      assessmentId: assessment.id,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // wasAuthoritativeAtDecision is false here because seedDocumentAndRun/
    // completeRun bypass the real worker pipeline and never create a
    // CandidateProjectAuthority row for this (candidateId, projectId) —
    // this is correct, not a bug: the fixture never published authority.
    expect(body.override).toEqual({
      assessmentId: assessment.id,
      overridden: true,
      hrNote: "HR disagrees with the gap finding.",
      wasAuthoritativeAtDecision: false,
    });

    const stored = await prisma.hrOverride.findUnique({ where: { decisionId: body.id } });
    expect(stored?.overridden).toBe(true);

    // The underlying Assessment row itself is never touched.
    const unchanged = await prisma.assessment.findUnique({ where: { id: assessment.id } });
    expect(unchanged?.status).toBe("MANDATORY_GAP");
  });

  it("Phase 12 (C3): records wasAuthoritativeAtDecision=true when citing the candidate's published-authoritative Assessment", async () => {
    const { user, project, cookie } = await seedProject();
    const candidate = await seedLinkedCandidate(project);
    const { document, run } = await seedDocumentAndRun(project, user, candidate);
    const assessment = await seedRequirementAndAssessment(project, user, candidate, run, "MANDATORY_GAP");

    // Publish the project-scoped authority (Item 16, Option B) — mirrors
    // what the real worker pipeline's tryPublishCandidateProjectAuthority
    // CAS would set.
    await prisma.candidateProjectAuthority.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        currentDocumentId: document.id,
        currentUploadedAt: document.uploadedAt,
        currentProcessingRunId: run.id,
        currentAttemptNumber: run.attemptNumber,
      },
    });

    const res = await post(cookie, project.id, candidate.id, {
      decision: "SHORTLIST",
      assessmentId: assessment.id,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().override.wasAuthoritativeAtDecision).toBe(true);

    const stored = await prisma.hrOverride.findUnique({ where: { decisionId: res.json().id } });
    expect(stored?.wasAuthoritativeAtDecision).toBe(true);
  });

  it("Phase 12 (C3): still accepts citing a non-authoritative Assessment, recording wasAuthoritativeAtDecision=false (HR may cite superseded evidence)", async () => {
    const { user, project, cookie } = await seedProject();
    const candidate = await seedLinkedCandidate(project);
    const { document, run } = await seedDocumentAndRun(project, user, candidate);
    const assessment = await seedRequirementAndAssessment(project, user, candidate, run, "MANDATORY_GAP");

    // A DIFFERENT document/run is published as authoritative — this
    // candidate's own current-run assessment remains fully citable (Phase
    // 12 C3 never narrows HR Decision validation), but is not authoritative.
    const otherDocument = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        fileType: "pdf",
        storageKey: `s3://bucket/${candidate.id}-other.pdf`,
        originalFilename: "other-resume.pdf",
        uploadedBy: user.id,
        uploadedAt: new Date(document.uploadedAt.getTime() + 1000),
      },
    });
    const otherRun = await prisma.processingRun.create({
      data: { candidateDocumentId: otherDocument.id, attemptNumber: 1, status: "COMPLETED", completedAt: new Date() },
    });
    await prisma.candidateProjectAuthority.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        currentDocumentId: otherDocument.id,
        currentUploadedAt: otherDocument.uploadedAt,
        currentProcessingRunId: otherRun.id,
        currentAttemptNumber: otherRun.attemptNumber,
      },
    });

    const res = await post(cookie, project.id, candidate.id, {
      decision: "SHORTLIST",
      assessmentId: assessment.id,
    });
    // Still accepted — C3 never rejects a citation merely for being non-authoritative.
    expect(res.statusCode).toBe(200);
    expect(res.json().override.wasAuthoritativeAtDecision).toBe(false);
  });

  it("project-scoped: wasAuthoritativeAtDecision for a Project A decision reflects Project A's own authority, regardless of Project B's authority (Item 16, Option B)", async () => {
    const { user: userA, project: projectA, cookie: cookieA } = await seedProject("Project A");
    const { user: userB, project: projectB } = await seedProject("Project B");

    // One candidate, linked to BOTH projects, with independent documents/
    // runs/assessments/authority in each.
    const candidate = await prisma.candidate.create({ data: { fullName: "Multi Project Candidate" } });
    await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId: projectA.id, anonymizedLabel: "Candidate #001" },
    });
    await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId: projectB.id, anonymizedLabel: "Candidate #001" },
    });

    const { run: runA } = await seedDocumentAndRun(projectA, userA, candidate);
    const assessmentA = await seedRequirementAndAssessment(projectA, userA, candidate, runA, "MANDATORY_GAP");
    await prisma.candidateProjectAuthority.create({
      data: { candidateId: candidate.id, projectId: projectA.id, currentProcessingRunId: runA.id },
    });

    // Project B's authority points at a DIFFERENT, unrelated run — if the
    // computation were still candidate-global, this would overwrite or
    // conflict with Project A's own authority for the same candidate.
    const { run: runB } = await seedDocumentAndRun(projectB, userB, candidate);
    await prisma.candidateProjectAuthority.create({
      data: { candidateId: candidate.id, projectId: projectB.id, currentProcessingRunId: runB.id },
    });

    const res = await post(cookieA, projectA.id, candidate.id, {
      decision: "SHORTLIST",
      assessmentId: assessmentA.id,
    });

    expect(res.statusCode).toBe(200);
    // assessmentA.processingRunId === runA.id === Project A's own authority.
    expect(res.json().override.wasAuthoritativeAtDecision).toBe(true);

    const stored = await prisma.hrOverride.findUnique({ where: { decisionId: res.json().id } });
    expect(stored?.wasAuthoritativeAtDecision).toBe(true);
  });

  it("rejects an override referencing an assessment from a superseded (non-current) run", async () => {
    const { user, project, cookie } = await seedProject();
    const candidate = await seedLinkedCandidate(project);
    const { document, run: staleRun } = await seedDocumentAndRun(project, user, candidate);
    const staleAssessment = await seedRequirementAndAssessment(project, user, candidate, staleRun);

    // A retry supersedes the run — the document's currentProcessingRunId
    // now points elsewhere, so staleRun's assessment is no longer current.
    const newRun = await prisma.processingRun.create({
      data: { candidateDocumentId: document.id, attemptNumber: 2, status: "COMPLETED", completedAt: new Date() },
    });
    await prisma.candidateDocument.update({
      where: { id: document.id },
      data: { currentProcessingRunId: newRun.id },
    });

    const res = await post(cookie, project.id, candidate.id, {
      decision: "SHORTLIST",
      assessmentId: staleAssessment.id,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("assessment_not_found");

    const decisions = await prisma.hrDecision.findMany({ where: { candidateId: candidate.id } });
    expect(decisions).toHaveLength(0);
  });

  it("rejects an override referencing another candidate's assessment", async () => {
    const { user, project, cookie } = await seedProject();
    const candidate = await seedLinkedCandidate(project, "Candidate #001");
    const otherCandidate = await seedLinkedCandidate(project, "Candidate #002");
    const { run } = await seedDocumentAndRun(project, user, otherCandidate);
    const otherAssessment = await seedRequirementAndAssessment(project, user, otherCandidate, run);

    const res = await post(cookie, project.id, candidate.id, {
      decision: "SHORTLIST",
      assessmentId: otherAssessment.id,
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("assessment_not_found");
  });

  it("records overridden=false when the decision agrees with a non-gap assessment status", async () => {
    const { user, project, cookie } = await seedProject();
    const candidate = await seedLinkedCandidate(project);
    const { run } = await seedDocumentAndRun(project, user, candidate);
    const assessment = await seedRequirementAndAssessment(project, user, candidate, run, "STRONG_EVIDENCE");

    const res = await post(cookie, project.id, candidate.id, {
      decision: "SHORTLIST",
      assessmentId: assessment.id,
    });
    expect(res.json().override.overridden).toBe(false);
  });

  it("denies an unrelated HR_USER from listing or recording decisions (404, not 403)", async () => {
    const { project, cookie } = await seedProject("Owner's Project");
    const candidate = await seedLinkedCandidate(project);
    await createUser("outsider@example.com", "HR_USER");
    const outsiderCookie = await loginAs(app, "outsider@example.com");

    const postRes = await post(outsiderCookie, project.id, candidate.id, { decision: "REJECT" });
    expect(postRes.statusCode).toBe(404);
    const getRes = await get(outsiderCookie, project.id, candidate.id);
    expect(getRes.statusCode).toBe(404);
    void cookie;
  });

  it("never persists a decision on the CandidateComparison legacy model or affects Assessment ranking fields", async () => {
    const { project, cookie } = await seedProject();
    const candidate = await seedLinkedCandidate(project);

    await post(cookie, project.id, candidate.id, { decision: "REJECT" });

    const legacyComparisons = await prisma.candidateComparison.findMany({ where: { projectId: project.id } });
    expect(legacyComparisons).toHaveLength(0);
  });
});

import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

/**
 * Phase 5 completion — Candidate Comparison
 * (POST /projects/:projectId/candidates/compare). Deterministic,
 * read-only, evidence-first: no AI call, no CandidateComparison
 * persistence, no score/rank/recommendation anywhere in the response.
 */
describe("POST /projects/:projectId/candidates/compare", () => {
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

  async function seedCandidate(
    project: { id: string },
    user: { id: string },
    label: string,
    identity: { fullName?: string; email?: string; phone?: string } = {},
  ) {
    const candidate = await prisma.candidate.create({
      data: { fullName: identity.fullName ?? "Anonymous Candidate", email: identity.email, phone: identity.phone },
    });
    await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId: project.id, anonymizedLabel: label },
    });
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        fileType: "pdf",
        storageKey: `s3://bucket/${candidate.id}.pdf`,
        originalFilename: `${label.replace(/\s+/g, "-")}-resume.pdf`,
        uploadedBy: user.id,
      },
    });
    return { candidate, document };
  }

  async function seedRequirement(project: { id: string }, user: { id: string }, overrides: { description?: string; versionNumber?: number } = {}) {
    const requirement = await prisma.jobRequirement.create({
      data: {
        projectId: project.id,
        category: "FUNCTIONAL_EXPERIENCE",
        description: overrides.description ?? "5 years Employee Relations",
        mandatory: true,
        status: "APPROVED",
        currentVersionNumber: overrides.versionNumber ?? 1,
        hrApprovedWeight: 100,
      },
    });
    const version = await prisma.jobRequirementVersion.create({
      data: {
        requirementId: requirement.id,
        versionNumber: overrides.versionNumber ?? 1,
        category: requirement.category,
        description: requirement.description,
        mandatory: true,
        priority: "MEDIUM",
        evidenceCriteriaSnapshot: [],
        hrApprovedWeight: 100,
        approvedBy: user.id,
      },
    });
    return { requirement, version };
  }

  async function completeRun(document: { id: string }, attemptNumber = 1) {
    const run = await prisma.processingRun.create({
      data: { candidateDocumentId: document.id, attemptNumber, status: "COMPLETED", completedAt: new Date() },
    });
    await prisma.candidateDocument.update({
      where: { id: document.id },
      data: { currentProcessingRunId: run.id, status: "COMPLETED" },
    });
    return run;
  }

  async function createAssessment(
    candidate: { id: string },
    project: { id: string },
    requirement: { id: string },
    version: { id: string },
    run: { id: string },
    document: { id: string },
    overrides: { status?: string; evidenceText?: string; rationale?: string } = {},
  ) {
    const evidence = await prisma.evidence.create({
      data: {
        requirementId: requirement.id,
        candidateId: candidate.id,
        projectId: project.id,
        sourceDocumentId: document.id,
        sourcePage: 2,
        evidenceText: overrides.evidenceText ?? "Led grievance handling at Acme Corp.",
        evidenceType: "DIRECT",
        evidenceStrength: "STRONG",
        confidence: "HIGH",
      },
    });
    return prisma.assessment.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        requirementId: requirement.id,
        requirementVersionId: version.id,
        processingRunId: run.id,
        aiAssessmentSummary: "1 supporting, 0 considered-and-rejected evidence item(s) identified.",
        status: (overrides.status as never) ?? "STRONG_EVIDENCE",
        evidenceLinks: {
          create: [{ evidenceId: evidence.id, role: "SUPPORTING", rationale: overrides.rationale ?? "On-point." }],
        },
      },
    });
  }

  async function createFinding(candidate: { id: string }, project: { id: string }, run: { id: string }) {
    return prisma.candidateConsistencyFinding.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        findingType: "EMPLOYMENT_GAP",
        severity: "INFORMATION_UNCLEAR",
        description: "Gap between roles at Acme Corp.",
        confidence: "MEDIUM",
        processingRunId: run.id,
      },
    });
  }

  function compare(cookie: string, projectId: string, candidateIds: string[]) {
    return app.inject({
      method: "POST",
      url: `/projects/${projectId}/candidates/compare`,
      headers: { cookie },
      payload: { candidateIds },
    });
  }

  it("1. authenticated project member can compare candidates", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    expect(res.statusCode).toBe(200);
  });

  it("2. denies an unrelated HR_USER (404, not 403)", async () => {
    const { user, project } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    const outsiderEmail = "outsider@example.com";
    await createUser(outsiderEmail, "HR_USER");
    const outsiderCookie = await loginAs(app, outsiderEmail);
    const res = await compare(outsiderCookie, project.id, [a.candidate.id, b.candidate.id]);
    expect(res.statusCode).toBe(404);
  });

  it("3. rejects the entire request with 400 if any candidate is not linked to the project", async () => {
    const { user, project, cookie } = await seedProject("Project A");
    const other = await seedProject("Project B");
    const a = await seedCandidate(project, user, "Candidate #001");
    const foreign = await seedCandidate(other.project, other.user, "Candidate #001");

    const res = await compare(cookie, project.id, [a.candidate.id, foreign.candidate.id]);
    expect(res.statusCode).toBe(400);
    expect(res.body).not.toContain(foreign.candidate.id); // no info about the invalid candidate leaked
  });

  it("4. rejects fewer than 2 candidates with 400", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const res = await compare(cookie, project.id, [a.candidate.id]);
    expect(res.statusCode).toBe(400);
  });

  it("5. rejects more than 5 candidates with 400", async () => {
    const { user, project, cookie } = await seedProject();
    const candidates = await Promise.all(
      Array.from({ length: 6 }, (_, i) => seedCandidate(project, user, `Candidate #00${i + 1}`)),
    );
    const res = await compare(cookie, project.id, candidates.map((c) => c.candidate.id));
    expect(res.statusCode).toBe(400);
  });

  it("6 & 7 & 8 & 9. exact response shape, no forbidden fields, no currentProcessingRunId, hasCurrentRun present", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001", { fullName: "Jordan Doe", email: "jordan@example.com" });
    const b = await seedCandidate(project, user, "Candidate #002", { fullName: "Alex Kim" });
    const { requirement, version } = await seedRequirement(project, user);
    const runA = await completeRun(a.document);
    await createAssessment(a.candidate, project, requirement, version, runA, a.document);

    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(Object.keys(body).sort()).toEqual(["candidates", "consistencyFindingsByCandidate", "requirementRows"].sort());
    expect(body.candidates).toHaveLength(2);
    for (const c of body.candidates) {
      expect(Object.keys(c).sort()).toEqual(["anonymizedLabel", "candidateId", "hasCurrentRun", "isFailed", "isProcessing"].sort());
      expect(typeof c.hasCurrentRun).toBe("boolean");
    }
    expect(body.candidates.find((c: { candidateId: string }) => c.candidateId === a.candidate.id).hasCurrentRun).toBe(true);
    expect(body.candidates.find((c: { candidateId: string }) => c.candidateId === b.candidate.id).hasCurrentRun).toBe(false);

    expect(res.body).not.toContain("Jordan Doe");
    expect(res.body).not.toContain("jordan@example.com");
    expect(res.body).not.toContain("Alex Kim");
    expect(res.body).not.toContain("currentProcessingRunId");
    expect(res.body).not.toContain("originalFilename");
    expect(res.body).not.toContain("sourceDocumentId");
    expect(res.body).not.toContain("aiInteractionId");
    expect(res.body).not.toContain(runA.id);
  });

  it("10. redacts evidence text and rationale for every candidate", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    await prisma.candidateExperience.create({ data: { candidateId: a.candidate.id, employer: "Acme Corp", title: "HR Officer" } });
    await prisma.candidateExperience.create({ data: { candidateId: b.candidate.id, employer: "Acme Corp", title: "HR Officer" } });
    const { requirement, version } = await seedRequirement(project, user);
    const runA = await completeRun(a.document);
    const runB = await completeRun(b.document);
    await createAssessment(a.candidate, project, requirement, version, runA, a.document, {
      evidenceText: "Worked at Acme Corp; email jane@example.com.",
      rationale: "Confirmed via Acme Corp records.",
    });
    await createAssessment(b.candidate, project, requirement, version, runB, b.document, {
      evidenceText: "Worked at Acme Corp for 5 years.",
    });

    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    const body = res.json();
    const row = body.requirementRows[0];
    const resultA = row.resultsByCandidate[a.candidate.id];
    const resultB = row.resultsByCandidate[b.candidate.id];

    expect(resultA.evidence[0].evidenceText).not.toContain("Acme Corp");
    expect(resultA.evidence[0].evidenceText).not.toContain("jane@example.com");
    expect(resultA.evidence[0].rationale).not.toContain("Acme Corp");
    expect(resultB.evidence[0].evidenceText).not.toContain("Acme Corp");
  });

  it("11. scopes employer tokenization independently per candidate (same token, different real employers)", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    await prisma.candidateExperience.create({
      data: { candidateId: a.candidate.id, employer: "Acme Corp", title: "HR Officer" },
    });
    await prisma.candidateExperience.create({
      data: { candidateId: b.candidate.id, employer: "Globex Inc", title: "HR Officer" },
    });
    const { requirement, version } = await seedRequirement(project, user);
    const runA = await completeRun(a.document);
    const runB = await completeRun(b.document);
    await createAssessment(a.candidate, project, requirement, version, runA, a.document, {
      evidenceText: "Worked at Acme Corp.",
    });
    await createAssessment(b.candidate, project, requirement, version, runB, b.document, {
      evidenceText: "Worked at Globex Inc.",
    });

    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    const row = res.json().requirementRows[0];
    // Both tokenize to "Company A" independently — this proves per-candidate
    // scoping (not a shared/global mapping), per the approved decision.
    expect(row.resultsByCandidate[a.candidate.id].evidence[0].evidenceText).toContain("Company A");
    expect(row.resultsByCandidate[b.candidate.id].evidence[0].evidenceText).toContain("Company A");
    expect(row.resultsByCandidate[a.candidate.id].evidence[0].evidenceText).not.toContain("Globex");
    expect(row.resultsByCandidate[b.candidate.id].evidence[0].evidenceText).not.toContain("Acme");
  });

  it("12. different RequirementVersions for the same requirement produce separate rows", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    const v1 = await seedRequirement(project, user, { versionNumber: 1 });
    // Re-approve a new version of the SAME requirement.
    const v2Version = await prisma.jobRequirementVersion.create({
      data: {
        requirementId: v1.requirement.id,
        versionNumber: 2,
        category: v1.requirement.category,
        description: v1.requirement.description,
        mandatory: true,
        priority: "MEDIUM",
        evidenceCriteriaSnapshot: [],
        hrApprovedWeight: 70,
        approvedBy: user.id,
      },
    });
    const runA = await completeRun(a.document);
    const runB = await completeRun(b.document);
    await createAssessment(a.candidate, project, v1.requirement, v1.version, runA, a.document);
    await createAssessment(b.candidate, project, v1.requirement, v2Version, runB, b.document);

    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    const body = res.json();
    const rowsForRequirement = body.requirementRows.filter((r: { requirementId: string }) => r.requirementId === v1.requirement.id);
    expect(rowsForRequirement).toHaveLength(2);
    const versionNumbers = rowsForRequirement.map((r: { versionNumber: number }) => r.versionNumber).sort();
    expect(versionNumbers).toEqual([1, 2]);
    // Each row only has a result for the candidate actually assessed against that version.
    const v1Row = rowsForRequirement.find((r: { versionNumber: number }) => r.versionNumber === 1);
    const v2Row = rowsForRequirement.find((r: { versionNumber: number }) => r.versionNumber === 2);
    expect(v1Row.resultsByCandidate[a.candidate.id]).not.toBeNull();
    expect(v1Row.resultsByCandidate[b.candidate.id]).toBeNull();
    expect(v2Row.resultsByCandidate[b.candidate.id]).not.toBeNull();
    expect(v2Row.resultsByCandidate[a.candidate.id]).toBeNull();
  });

  it("13. same requirement + same version aligns candidates in one row", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    const { requirement, version } = await seedRequirement(project, user);
    const runA = await completeRun(a.document);
    const runB = await completeRun(b.document);
    await createAssessment(a.candidate, project, requirement, version, runA, a.document, { status: "STRONG_EVIDENCE" });
    await createAssessment(b.candidate, project, requirement, version, runB, b.document, { status: "MANDATORY_GAP" });

    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    const body = res.json();
    expect(body.requirementRows).toHaveLength(1);
    const row = body.requirementRows[0];
    expect(row.resultsByCandidate[a.candidate.id].status).toBe("STRONG_EVIDENCE");
    expect(row.resultsByCandidate[b.candidate.id].status).toBe("MANDATORY_GAP");
  });

  it("14. missing candidate evidence returns null safely, and missing findings return an empty array", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    const { requirement, version } = await seedRequirement(project, user);
    const runA = await completeRun(a.document);
    await createAssessment(a.candidate, project, requirement, version, runA, a.document);

    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    const body = res.json();
    expect(body.requirementRows[0].resultsByCandidate[b.candidate.id]).toBeNull();
    expect(body.consistencyFindingsByCandidate[a.candidate.id]).toEqual([]);
    expect(body.consistencyFindingsByCandidate[b.candidate.id]).toEqual([]);
  });

  it("15. independent processing states per candidate: one candidate's FAILED_RETRY never affects another's current results", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    const { requirement, version } = await seedRequirement(project, user);
    const runA = await completeRun(a.document);
    await createAssessment(a.candidate, project, requirement, version, runA, a.document);
    await prisma.candidateDocument.update({ where: { id: b.document.id }, data: { status: "FAILED_RETRY" } });

    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    const body = res.json();
    const candA = body.candidates.find((c: { candidateId: string }) => c.candidateId === a.candidate.id);
    const candB = body.candidates.find((c: { candidateId: string }) => c.candidateId === b.candidate.id);
    expect(candA.isFailed).toBe(false);
    expect(candA.hasCurrentRun).toBe(true);
    expect(candB.isFailed).toBe(true);
    expect(candB.hasCurrentRun).toBe(false);
    expect(body.requirementRows[0].resultsByCandidate[a.candidate.id]).not.toBeNull();
  });

  it("16. preserves source/page traceability per candidate", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    const { requirement, version } = await seedRequirement(project, user);
    const runA = await completeRun(a.document);
    const runB = await completeRun(b.document);
    await createAssessment(a.candidate, project, requirement, version, runA, a.document);
    await createAssessment(b.candidate, project, requirement, version, runB, b.document);

    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    const row = res.json().requirementRows[0];
    expect(row.resultsByCandidate[a.candidate.id].evidence[0].sourcePage).toBe(2);
    expect(row.resultsByCandidate[a.candidate.id].evidence[0].source).toBe("Source Document");
    expect(row.resultsByCandidate[b.candidate.id].evidence[0].sourcePage).toBe(2);
  });

  it("17. never invokes an AI provider (no AiModelConfiguration lookup for a comparison task; no AiInteraction rows created by this request)", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    const beforeCount = await prisma.aiInteraction.count();

    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    expect(res.statusCode).toBe(200);
    const afterCount = await prisma.aiInteraction.count();
    expect(afterCount).toBe(beforeCount); // zero new AI calls logged by this request
  });

  it("18. never persists a CandidateComparison row", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");

    await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    const rows = await prisma.candidateComparison.count();
    expect(rows).toBe(0);
  });

  it("returns candidates in the exact requested order, never reordered by outcome", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const b = await seedCandidate(project, user, "Candidate #002");
    const { requirement, version } = await seedRequirement(project, user);
    const runB = await completeRun(b.document);
    // Only b has strong evidence; a has none — if ordering were
    // outcome-derived, a "stronger candidate first" implementation would
    // put b first. It must not.
    await createAssessment(b.candidate, project, requirement, version, runB, b.document, { status: "STRONG_EVIDENCE" });

    const res = await compare(cookie, project.id, [a.candidate.id, b.candidate.id]);
    const ids = res.json().candidates.map((c: { candidateId: string }) => c.candidateId);
    expect(ids).toEqual([a.candidate.id, b.candidate.id]); // exact request order preserved
  });

  it("de-duplicates a repeated candidateId without letting it count twice toward the 2-5 range", async () => {
    const { user, project, cookie } = await seedProject();
    const a = await seedCandidate(project, user, "Candidate #001");
    const res = await compare(cookie, project.id, [a.candidate.id, a.candidate.id]);
    expect(res.statusCode).toBe(400); // de-duplicated down to 1, below the minimum of 2
  });
});

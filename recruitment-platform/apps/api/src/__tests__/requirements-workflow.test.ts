import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { buildApp } from "../app.js";
import { createUser, loginAs, resetDatabase, FakeAIProvider, seedAiModelConfig } from "./test-utils.js";

describe("job requirements: AI interpretation, weighting, approval, versioning, audit", () => {
  let app: FastifyInstance;
  let cookie: string;
  let projectId: string;

  const fakeProvider = new FakeAIProvider({
    REQUIREMENT_INTERPRETATION: (requirementIds) => ({
      interpretations: requirementIds.map((requirementId) => ({
        requirementId,
        interpretationSummary: "Requires hands-on employee relations casework.",
        semanticConcepts: [
          { concept: "Grievance handling", relevance: "DIRECT", rationale: "Core employee relations activity." },
          { concept: "Payroll processing", relevance: "NOT_RELEVANT", rationale: "Unrelated administrative function." },
        ],
        evidenceCriteria: ["Grievance handling", "Disciplinary investigations", "Conflict resolution"],
      })),
    }),
    WEIGHTING_RECOMMENDATION: (requirementIds) => ({
      weights: requirementIds.map((requirementId, index) => ({
        requirementId,
        suggestedWeight: index === 0 ? 100 : 0,
        rationale: "Sole mandatory requirement.",
      })),
    }),
  });

  beforeEach(async () => {
    await resetDatabase();
    app = await buildApp({
      sessionSecret: "test-session-secret-not-for-production-use-only",
      nodeEnv: "test",
      providers: { fake: fakeProvider },
      logger: false,
    });
    await createUser("hr@example.com", "HR_USER");
    cookie = await loginAs(app, "hr@example.com");
    const createRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: { title: "HR Manager" },
    });
    projectId = createRes.json().id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createRequirement() {
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements`,
      headers: { cookie },
      payload: {
        category: "FUNCTIONAL_EXPERIENCE",
        description: "Minimum 5 years of Employee Relations experience.",
        mandatory: true,
      },
    });
    return res.json();
  }

  it("creates a requirement in DRAFT status", async () => {
    const requirement = await createRequirement();
    expect(requirement.status).toBe("DRAFT");
    expect(requirement.category).toBe("FUNCTIONAL_EXPERIENCE");
    expect(requirement.mandatory).toBe(true);
  });

  it("edits a draft requirement and keeps it in DRAFT (never-approved requirement)", async () => {
    const requirement = await createRequirement();
    const res = await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirement.id}`,
      headers: { cookie },
      payload: { description: "Minimum 6 years of Employee Relations experience." },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("DRAFT");
  });

  it("runs AI interpretation (mocked provider) and stores semantic concepts + evidence criteria, distinguishing relevance tiers", async () => {
    await seedAiModelConfig("REQUIREMENT_INTERPRETATION");
    const requirement = await createRequirement();

    const interpretRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements/interpret`,
      headers: { cookie },
    });
    expect(interpretRes.statusCode).toBe(200);

    const stored = await prisma.jobRequirement.findUnique({
      where: { id: requirement.id },
      include: { semanticConcepts: true, criteria: true },
    });
    expect(stored?.status).toBe("AI_ANALYZED");
    expect(stored?.criteria.map((c) => c.description)).toEqual([
      "Grievance handling",
      "Disciplinary investigations",
      "Conflict resolution",
    ]);
    const relevances = stored?.semanticConcepts.map((c) => c.relevance).sort();
    expect(relevances).toEqual(["DIRECT", "NOT_RELEVANT"]);
  });

  it("runs AI weighting recommendation and stores it as a proposal only, not HR approval", async () => {
    await seedAiModelConfig("WEIGHTING_RECOMMENDATION");
    const requirement = await createRequirement();

    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements/weighting-recommendation`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);

    const stored = await prisma.jobRequirement.findUnique({ where: { id: requirement.id } });
    expect(Number(stored?.aiSuggestedWeight)).toBe(100);
    expect(stored?.hrApprovedWeight).toBeNull(); // AI proposes; nothing here is HR-approved yet
    expect(stored?.status).toBe("HR_REVIEW");
  });

  it("rejects approval when the total HR-approved weight is not 100", async () => {
    const a = await createRequirement();
    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements`,
      headers: { cookie },
      payload: { category: "TECHNICAL_SKILLS", description: "Advanced Excel", mandatory: false },
    });
    const b = res.json();

    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${a.id}/weight`,
      headers: { cookie },
      payload: { weight: 50 },
    });
    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${b.id}/weight`,
      headers: { cookie },
      payload: { weight: 30 }, // totals 80, not 100
    });

    const approveRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements/approve`,
      headers: { cookie },
    });
    expect(approveRes.statusCode).toBe(400);
    expect(approveRes.json().error).toBe("weights_must_total_100");
  });

  it("requires an HR note only when the weight diverges from the AI suggestion", async () => {
    const requirement = await createRequirement();
    await prisma.jobRequirement.update({
      where: { id: requirement.id },
      data: { aiSuggestedWeight: 100 },
    });

    const acceptAiWeight = await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirement.id}/weight`,
      headers: { cookie },
      payload: { weight: 100 },
    });
    expect(acceptAiWeight.statusCode).toBe(200);

    const diverge = await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirement.id}/weight`,
      headers: { cookie },
      payload: { weight: 80 },
    });
    expect(diverge.statusCode).toBe(400);
    expect(diverge.json().error).toBe("hr_note_required");

    const withNote = await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirement.id}/weight`,
      headers: { cookie },
      payload: { weight: 80, hrNote: "Reduced — this org weighs certifications more heavily." },
    });
    expect(withNote.statusCode).toBe(200);
  });

  it("approves at 100%, creates an immutable version snapshot, and moves the project to READY_FOR_CV_UPLOAD", async () => {
    const requirement = await createRequirement();
    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirement.id}/weight`,
      headers: { cookie },
      payload: { weight: 100 },
    });

    const approveRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements/approve`,
      headers: { cookie },
    });
    expect(approveRes.statusCode).toBe(200);
    const body = approveRes.json();
    expect(body.project.status).toBe("READY_FOR_CV_UPLOAD");
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0].versionNumber).toBe(1);
    expect(Number(body.versions[0].hrApprovedWeight)).toBe(100);

    const updatedRequirement = await prisma.jobRequirement.findUnique({ where: { id: requirement.id } });
    expect(updatedRequirement?.status).toBe("APPROVED");
    expect(updatedRequirement?.currentVersionNumber).toBe(1);
  });

  it("moves an approved requirement to CHANGED on edit and never overwrites the approved version snapshot", async () => {
    const requirement = await createRequirement();
    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirement.id}/weight`,
      headers: { cookie },
      payload: { weight: 100 },
    });
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements/approve`,
      headers: { cookie },
    });

    const editRes = await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirement.id}`,
      headers: { cookie },
      payload: { description: "Minimum 7 years of Employee Relations experience." },
    });
    expect(editRes.json().status).toBe("CHANGED");

    const versions = await prisma.jobRequirementVersion.findMany({ where: { requirementId: requirement.id } });
    expect(versions).toHaveLength(1);
    expect(versions[0].description).toBe("Minimum 5 years of Employee Relations experience.");

    // Re-approving must create version 2, not mutate version 1.
    const reApprove = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements/approve`,
      headers: { cookie },
    });
    expect(reApprove.json().versions[0].versionNumber).toBe(2);
    const versionsAfter = await prisma.jobRequirementVersion.findMany({
      where: { requirementId: requirement.id },
      orderBy: { versionNumber: "asc" },
    });
    expect(versionsAfter).toHaveLength(2);
    expect(versionsAfter[0].description).toBe("Minimum 5 years of Employee Relations experience.");
    expect(versionsAfter[1].description).toBe("Minimum 7 years of Employee Relations experience.");
  });

  it("records an audit entry for project creation, requirement edit, weight change, and version approval", async () => {
    const requirement = await createRequirement();
    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirement.id}`,
      headers: { cookie },
      payload: { description: "Minimum 5 years of Employee Relations experience, revised." },
    });
    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirement.id}/weight`,
      headers: { cookie },
      payload: { weight: 100 },
    });
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements/approve`,
      headers: { cookie },
    });

    const actions = (await prisma.auditLog.findMany({ orderBy: { createdAt: "asc" } })).map((a) => a.action);
    expect(actions).toContain("PROJECT_CREATED");
    expect(actions).toContain("REQUIREMENT_CREATED");
    expect(actions).toContain("REQUIREMENT_EDITED");
    expect(actions).toContain("REQUIREMENT_WEIGHT_CHANGED");
    expect(actions).toContain("REQUIREMENT_VERSION_APPROVED");
    expect(actions).toContain("PROJECT_STATUS_CHANGED");

    const projectCreated = await prisma.auditLog.findFirst({ where: { action: "PROJECT_CREATED" } });
    expect(projectCreated?.actorId).not.toBeNull();
    expect(projectCreated?.createdAt).toBeInstanceOf(Date);
  });
});

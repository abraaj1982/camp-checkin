import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

/**
 * ON_HOLD -> READY_FOR_CV_UPLOAD resume (Sprint 2 follow-up). This is
 * deliberately NOT a re-run of /requirements/approve — it must not create a
 * new JobRequirementVersion or bump currentVersionNumber when nothing has
 * changed since the project was paused. It reuses the exact same weight
 * math /approve uses (validateWeightTotal) plus one additional condition
 * /approve itself doesn't need: every non-archived requirement must
 * currently be APPROVED, since PATCH .../weight can silently change an
 * already-approved requirement's weight without reverting its status.
 */
describe("project lifecycle: ON_HOLD -> READY_FOR_CV_UPLOAD resume", () => {
  let app: FastifyInstance;
  let cleanupStorage: () => Promise<void>;
  let cookie: string;
  let projectId: string;

  beforeEach(async () => {
    await resetDatabase();
    const { storage, cleanup } = await createTestStorage();
    cleanupStorage = cleanup;
    app = await buildTestApp({ storage });

    await createUser("owner@example.com", "HR_USER");
    cookie = await loginAs(app, "owner@example.com");
    const projectRes = await app.inject({
      method: "POST",
      url: "/projects",
      headers: { cookie },
      payload: { title: "HR Manager" },
    });
    projectId = projectRes.json().id;
  });

  afterEach(async () => {
    await cleanupStorage();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function addRequirement(weight: number) {
    const reqRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements`,
      headers: { cookie },
      payload: { category: "FUNCTIONAL_EXPERIENCE", description: "5 years Employee Relations", mandatory: true },
    });
    const requirementId = reqRes.json().id;
    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirementId}/weight`,
      headers: { cookie },
      payload: { weight },
    });
    return requirementId;
  }

  async function approveAndPause() {
    await app.inject({ method: "POST", url: `/projects/${projectId}/requirements/approve`, headers: { cookie } });
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "ON_HOLD" },
    });
  }

  it("resumes successfully when all non-archived requirements remain APPROVED and weights still total 100%, creating no new version", async () => {
    const requirementId = await addRequirement(100);
    await approveAndPause();

    const versionsBefore = await prisma.jobRequirementVersion.count({ where: { requirementId } });
    const requirementBefore = await prisma.jobRequirement.findUniqueOrThrow({ where: { id: requirementId } });

    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "READY_FOR_CV_UPLOAD" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("READY_FOR_CV_UPLOAD");

    const versionsAfter = await prisma.jobRequirementVersion.count({ where: { requirementId } });
    const requirementAfter = await prisma.jobRequirement.findUniqueOrThrow({ where: { id: requirementId } });
    expect(versionsAfter).toBe(versionsBefore); // no re-versioning
    expect(requirementAfter.currentVersionNumber).toBe(requirementBefore.currentVersionNumber);
  });

  it("rejects resume when the project has no approved requirements at all", async () => {
    // Paused directly from ACTIVE, never approved.
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "ACTIVE" },
    });
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "ON_HOLD" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "READY_FOR_CV_UPLOAD" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("requirements_not_approved");

    const project = await prisma.recruitmentProject.findUniqueOrThrow({ where: { id: projectId } });
    expect(project.status).toBe("ON_HOLD"); // unchanged
  });

  it("rejects resume when a requirement was edited to CHANGED after approval, even though weights still total 100%", async () => {
    const requirementId = await addRequirement(100);
    await approveAndPause();

    // Edit content post-approval — moves the requirement to CHANGED without
    // touching the project's own status (pre-existing behavior).
    await app.inject({
      method: "PATCH",
      url: `/projects/${projectId}/requirements/${requirementId}`,
      headers: { cookie },
      payload: { description: "6 years Employee Relations" },
    });
    const requirement = await prisma.jobRequirement.findUniqueOrThrow({ where: { id: requirementId } });
    expect(requirement.status).toBe("CHANGED");
    expect(Number(requirement.hrApprovedWeight)).toBe(100); // weight itself is untouched — still totals 100%

    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "READY_FOR_CV_UPLOAD" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("requirements_not_approved");
  });

  it("ignores an ARCHIVED requirement entirely — it neither blocks nor is required to satisfy eligibility", async () => {
    const liveRequirementId = await addRequirement(100);
    await approveAndPause();

    // Resume to ACTIVE to allow the archive action is unnecessary here —
    // archiving is a requirement-level action, not project-level; add a
    // second requirement with no weight at all, then archive it.
    const secondReqRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/requirements`,
      headers: { cookie },
      payload: { category: "EDUCATION", description: "Bachelor's degree", mandatory: false },
    });
    const archivedId = secondReqRes.json().id;
    await app.inject({
      method: "DELETE",
      url: `/projects/${projectId}/requirements/${archivedId}`,
      headers: { cookie },
    });
    const archived = await prisma.jobRequirement.findUniqueOrThrow({ where: { id: archivedId } });
    expect(archived.status).toBe("ARCHIVED");
    expect(archived.hrApprovedWeight).toBeNull(); // never weighted/approved — would fail eligibility if it counted

    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "READY_FOR_CV_UPLOAD" },
    });
    expect(res.statusCode).toBe(200);
    void liveRequirementId;
  });

  it("preserves the existing DRAFT -> ACTIVE -> ARCHIVED transitions and authorization (member 403, owner 200)", async () => {
    const member = await createUser("member@example.com", "HR_USER");
    const memberCookie = await loginAs(app, "member@example.com");
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/members`,
      headers: { cookie },
      payload: { userId: member.id, role: "MEMBER" },
    });

    const activateRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "ACTIVE" },
    });
    expect(activateRes.statusCode).toBe(200);

    const memberArchiveRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie: memberCookie },
      payload: { status: "ARCHIVED" },
    });
    expect(memberArchiveRes.statusCode).toBe(403);

    const ownerArchiveRes = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "ARCHIVED" },
    });
    expect(ownerArchiveRes.statusCode).toBe(200);
  });

  it("still rejects a genuinely disallowed transition (ARCHIVED has no further transitions)", async () => {
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "ACTIVE" },
    });
    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "ARCHIVED" },
    });

    const res = await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "ACTIVE" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_status_transition");
  });

  it("audits the successful resume exactly like any other status change", async () => {
    await addRequirement(100);
    await approveAndPause();

    await app.inject({
      method: "POST",
      url: `/projects/${projectId}/status`,
      headers: { cookie },
      payload: { status: "READY_FOR_CV_UPLOAD" },
    });

    const entries = await prisma.auditLog.findMany({
      where: { entityId: projectId, action: "PROJECT_STATUS_CHANGED" },
      orderBy: { createdAt: "asc" },
    });
    const last = entries[entries.length - 1];
    expect((last.beforeJson as { status: string }).status).toBe("ON_HOLD");
    expect((last.afterJson as { status: string }).status).toBe("READY_FOR_CV_UPLOAD");
  });
});

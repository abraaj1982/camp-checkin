import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

describe("Audit Read API: GET /projects/:projectId/audit-log", () => {
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

  async function seedProject(title: string) {
    const email = `hr-${Math.random().toString(36).slice(2)}@example.com`;
    const user = await createUser(email, "HR_USER");
    const cookie = await loginAs(app, email);
    const res = await app.inject({ method: "POST", url: "/projects", headers: { cookie }, payload: { title } });
    return { user, cookie, project: res.json() };
  }

  function getAuditLog(cookie: string, projectId: string, qs = "") {
    return app.inject({ method: "GET", url: `/projects/${projectId}/audit-log${qs}`, headers: { cookie } });
  }

  // --- Authorization ---------------------------------------------------

  it("an authorized project member can read the project's audit log", async () => {
    const { cookie, project } = await seedProject("Member Access");
    const res = await getAuditLog(cookie, project.id);
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().events)).toBe(true);
  });

  it("a non-member receives 404, not 403, matching the existing project-access convention", async () => {
    const { project } = await seedProject("Owner Only");
    const outsiderEmail = `outsider-${Math.random().toString(36).slice(2)}@example.com`;
    await createUser(outsiderEmail, "HR_USER");
    const outsiderCookie = await loginAs(app, outsiderEmail);
    const res = await getAuditLog(outsiderCookie, project.id);
    expect(res.statusCode).toBe(404);
  });

  it("HR_ADMIN can read without project membership, matching requireProjectAccess()", async () => {
    const { project } = await seedProject("Needs Admin Access");
    const adminEmail = `admin-${Math.random().toString(36).slice(2)}@example.com`;
    await createUser(adminEmail, "HR_ADMIN");
    const adminCookie = await loginAs(app, adminEmail);
    const res = await getAuditLog(adminCookie, project.id);
    expect(res.statusCode).toBe(200);
  });

  // --- Project scoping ---------------------------------------------------

  it("project A cannot see project B's requirement events, and vice versa", async () => {
    const a = await seedProject("Project A");
    const b = await seedProject("Project B");

    await app.inject({
      method: "POST",
      url: `/projects/${a.project.id}/requirements`,
      headers: { cookie: a.cookie },
      payload: { category: "TECHNICAL_SKILLS", description: "Project A requirement", mandatory: true },
    });
    await app.inject({
      method: "POST",
      url: `/projects/${b.project.id}/requirements`,
      headers: { cookie: b.cookie },
      payload: { category: "TECHNICAL_SKILLS", description: "Project B requirement", mandatory: true },
    });

    const resA = (await getAuditLog(a.cookie, a.project.id)).json();
    const resB = (await getAuditLog(b.cookie, b.project.id)).json();

    expect(resA.events.some((e: { action: string }) => e.action === "REQUIREMENT_CREATED")).toBe(true);
    expect(resA.events.every((e: { entityId: string }) => e.entityId !== undefined)).toBe(true);
    // Project A's feed must not contain Project B's own RecruitmentProject-
    // level events at all (the only unambiguous cross-project leak check
    // that doesn't depend on JobRequirement row ids we don't have handles to).
    expect(resA.events.some((e: { entityId: string }) => e.entityId === b.project.id)).toBe(false);
    expect(resB.events.some((e: { entityId: string }) => e.entityId === a.project.id)).toBe(false);
  });

  it("JobRequirementVersion events resolve through their parent requirement's project", async () => {
    const { cookie, project } = await seedProject("Versioned Requirement");
    const createRes = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/requirements`,
      headers: { cookie },
      payload: { category: "TECHNICAL_SKILLS", description: "Advanced Excel", mandatory: true },
    });
    const requirement = createRes.json();
    await app.inject({
      method: "PATCH",
      url: `/projects/${project.id}/requirements/${requirement.id}/weight`,
      headers: { cookie },
      payload: { weight: 100 },
    });
    const approveRes = await app.inject({
      method: "POST",
      url: `/projects/${project.id}/requirements/approve`,
      headers: { cookie },
    });
    expect(approveRes.statusCode).toBe(200);

    const res = await getAuditLog(cookie, project.id);
    const actions = res.json().events.map((e: { action: string }) => e.action);
    expect(actions).toContain("REQUIREMENT_VERSION_APPROVED");
  });

  it("excludes a CandidateDocument audit event whose document has projectId = null", async () => {
    const { cookie, user, project } = await seedProject("Null Document Project");
    const candidate = await prisma.candidate.create({ data: { fullName: "No Project Doc" } });
    const orphanDocument = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: null,
        fileType: "pdf",
        storageKey: "s3://bucket/orphan.pdf",
        originalFilename: "orphan.pdf",
        uploadedBy: user.id,
      },
    });
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: "CANDIDATE_DOCUMENT_PROCESSED",
        entityType: "CandidateDocument",
        entityId: orphanDocument.id,
        afterJson: { experiences: 1 },
      },
    });

    const res = await getAuditLog(cookie, project.id);
    expect(res.json().events.some((e: { entityId: string }) => e.entityId === orphanDocument.id)).toBe(false);
  });

  it("returns a shared Candidate event for every project the candidate is actually linked to", async () => {
    const a = await seedProject("Shared Candidate A");
    const b = await seedProject("Shared Candidate B");
    const candidate = await prisma.candidate.create({ data: { fullName: "Multi Project Candidate" } });
    await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId: a.project.id, anonymizedLabel: "Candidate #1" },
    });
    await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId: b.project.id, anonymizedLabel: "Candidate #1" },
    });
    await prisma.auditLog.create({
      data: {
        actorId: a.user.id,
        action: "CANDIDATE_PROMOTED_FROM_STAGED_UPLOAD",
        entityType: "Candidate",
        entityId: candidate.id,
        afterJson: { projectId: a.project.id },
      },
    });

    const resA = await getAuditLog(a.cookie, a.project.id);
    const resB = await getAuditLog(b.cookie, b.project.id);
    expect(resA.json().events.some((e: { entityId: string }) => e.entityId === candidate.id)).toBe(true);
    expect(resB.json().events.some((e: { entityId: string }) => e.entityId === candidate.id)).toBe(true);
  });

  it("includes CANDIDATE_PII_PURGED only for a project present in its payload, with a sanitized summary", async () => {
    const a = await seedProject("Purge Project A");
    const b = await seedProject("Purge Project B");
    const candidate = await prisma.candidate.create({ data: { fullName: "Purged Candidate" } });
    await prisma.auditLog.create({
      data: {
        actorId: null,
        action: "CANDIDATE_PII_PURGED",
        entityType: "Candidate",
        entityId: candidate.id,
        afterJson: {
          projectIdsCausingEligibility: [a.project.id],
          trigger: "SCHEDULED",
          documentIds: ["doc-1", "doc-2"],
          documentCount: 2,
          failedDocumentIds: [],
          result: "SUCCESS",
        },
      },
    });

    const resA = (await getAuditLog(a.cookie, a.project.id)).json();
    const resB = (await getAuditLog(b.cookie, b.project.id)).json();

    const purgeEventA = resA.events.find((e: { action: string }) => e.action === "CANDIDATE_PII_PURGED");
    expect(purgeEventA).toBeDefined();
    expect(purgeEventA.summary).toBe("Candidate personal data was purged.");
    expect(resB.events.some((e: { action: string }) => e.action === "CANDIDATE_PII_PURGED")).toBe(false);
  });

  // --- Privacy -----------------------------------------------------------

  it("never exposes beforeJson, afterJson, or any raw payload field, including purge-specific fields", async () => {
    const { cookie, user, project } = await seedProject("Privacy Check");
    await prisma.auditLog.create({
      data: {
        actorId: null,
        action: "CANDIDATE_PII_PURGED",
        entityType: "Candidate",
        entityId: "some-candidate-id",
        afterJson: { projectIdsCausingEligibility: [project.id], documentIds: ["doc-x"], trigger: "MANUAL" },
      },
    });
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: "PROJECT_EDITED",
        entityType: "RecruitmentProject",
        entityId: project.id,
        beforeJson: { title: "Old Title" },
        afterJson: { title: "New Title" },
      },
    });

    const events = (await getAuditLog(cookie, project.id)).json().events;
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const keys = Object.keys(event).sort();
      expect(keys).toEqual(["action", "actorDisplayName", "createdAt", "entityId", "entityType", "id", "summary"]);
      expect(JSON.stringify(event)).not.toContain("projectIdsCausingEligibility");
      expect(JSON.stringify(event)).not.toContain("documentIds");
      expect(JSON.stringify(event)).not.toContain("Old Title");
      expect(JSON.stringify(event)).not.toContain("beforeJson");
      expect(JSON.stringify(event)).not.toContain("afterJson");
    }
  });

  // --- Exclusions ----------------------------------------------------------

  it("excludes LOGIN and LOGOUT actions even if they would otherwise match a project's own entity", async () => {
    const { cookie, user, project } = await seedProject("Login Exclusion");
    await prisma.auditLog.create({
      data: { actorId: user.id, action: "LOGIN", entityType: "RecruitmentProject", entityId: project.id },
    });
    await prisma.auditLog.create({
      data: { actorId: user.id, action: "LOGOUT", entityType: "RecruitmentProject", entityId: project.id },
    });
    await prisma.auditLog.create({
      data: { actorId: user.id, action: "PROJECT_EDITED", entityType: "RecruitmentProject", entityId: project.id },
    });

    const actions = (await getAuditLog(cookie, project.id)).json().events.map((e: { action: string }) => e.action);
    expect(actions).not.toContain("LOGIN");
    expect(actions).not.toContain("LOGOUT");
    expect(actions).toContain("PROJECT_EDITED");
  });

  // --- Ordering / pagination ----------------------------------------------

  it("orders newest first, using id as a deterministic tie-breaker for identical timestamps", async () => {
    const { cookie, user, project } = await seedProject("Ordering");
    const sameInstant = new Date("2026-01-01T00:00:00.000Z");
    const earlier = new Date("2025-12-31T00:00:00.000Z");

    const older = await prisma.auditLog.create({
      data: { actorId: user.id, action: "PROJECT_EDITED", entityType: "RecruitmentProject", entityId: project.id, createdAt: earlier },
    });
    const tieA = await prisma.auditLog.create({
      data: { actorId: user.id, action: "PROJECT_EDITED", entityType: "RecruitmentProject", entityId: project.id, createdAt: sameInstant },
    });
    const tieB = await prisma.auditLog.create({
      data: { actorId: user.id, action: "PROJECT_EDITED", entityType: "RecruitmentProject", entityId: project.id, createdAt: sameInstant },
    });

    const events = (await getAuditLog(cookie, project.id)).json().events;
    // PROJECT_CREATED (from seedProject) is oldest; ids with the same
    // createdAt must come back in descending id order, both newer than
    // the earlier-timestamped row.
    const ids = events.map((e: { id: string }) => e.id);
    const expectedTieOrder = [tieA.id, tieB.id].sort().reverse();
    const tiePositions = expectedTieOrder.map((id) => ids.indexOf(id));
    expect(tiePositions[0]).toBeLessThan(tiePositions[1]);
    expect(ids.indexOf(tieA.id)).toBeLessThan(ids.indexOf(older.id));
    expect(ids.indexOf(tieB.id)).toBeLessThan(ids.indexOf(older.id));
  });

  it("defaults to a page size of 25 and clamps an oversized pageSize to 100", async () => {
    const { cookie, user, project } = await seedProject("Pagination Defaults");
    for (let i = 0; i < 30; i++) {
      await prisma.auditLog.create({
        data: { actorId: user.id, action: "PROJECT_EDITED", entityType: "RecruitmentProject", entityId: project.id },
      });
    }

    const defaultRes = (await getAuditLog(cookie, project.id)).json();
    expect(defaultRes.pageSize).toBe(25);
    expect(defaultRes.events.length).toBe(25);
    expect(defaultRes.hasMore).toBe(true);

    const clampedRes = (await getAuditLog(cookie, project.id, "?pageSize=500")).json();
    expect(clampedRes.pageSize).toBe(100);
  });

  it("respects page boundaries and reports hasMore correctly on the last page", async () => {
    const { cookie, user, project } = await seedProject("Pagination Boundaries");
    // seedProject itself already wrote PROJECT_CREATED — 4 more makes 5 total.
    for (let i = 0; i < 4; i++) {
      await prisma.auditLog.create({
        data: { actorId: user.id, action: "PROJECT_EDITED", entityType: "RecruitmentProject", entityId: project.id },
      });
    }

    const page1 = (await getAuditLog(cookie, project.id, "?page=1&pageSize=2")).json();
    expect(page1.events.length).toBe(2);
    expect(page1.hasMore).toBe(true);

    const page3 = (await getAuditLog(cookie, project.id, "?page=3&pageSize=2")).json();
    expect(page3.events.length).toBe(1);
    expect(page3.hasMore).toBe(false);
  });

  // --- Presentation --------------------------------------------------------

  it("gives known actions their expected summary, and an unknown action a generic fail-closed summary with no raw payload", async () => {
    const { cookie, user, project } = await seedProject("Presentation");
    await prisma.auditLog.create({
      data: {
        actorId: user.id,
        action: "SOME_FUTURE_ACTION_NOT_YET_MAPPED",
        entityType: "RecruitmentProject",
        entityId: project.id,
        afterJson: { secret: "must-not-leak" },
      },
    });

    const events = (await getAuditLog(cookie, project.id)).json().events;
    const created = events.find((e: { action: string }) => e.action === "PROJECT_CREATED");
    expect(created.summary).toBe("Project created.");

    const unknown = events.find((e: { action: string }) => e.action === "SOME_FUTURE_ACTION_NOT_YET_MAPPED");
    expect(unknown.summary).toBe("An audited event occurred.");
    expect(JSON.stringify(unknown)).not.toContain("secret");
    expect(JSON.stringify(unknown)).not.toContain("must-not-leak");
  });
});

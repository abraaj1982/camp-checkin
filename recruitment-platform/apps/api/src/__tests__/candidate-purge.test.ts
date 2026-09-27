import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

/**
 * Phase 8 — PII Retention/Purge. API-layer authorization/shape/idempotency
 * tests. Eligibility/execution/recovery logic itself is covered in
 * packages/candidate-retention/src/__tests__/candidate-purge.test.ts,
 * which this route module calls directly — these tests exercise the HTTP
 * surface (auth, DTOs, error codes) on top of it.
 */
describe("Candidate PII purge (Phase 8, admin-only API)", () => {
  let app: FastifyInstance;
  let cleanupStorage: () => Promise<void>;
  let adminCookie: string;

  beforeEach(async () => {
    await resetDatabase();
    const { storage, cleanup } = await createTestStorage();
    cleanupStorage = cleanup;
    app = await buildTestApp({ storage });
    await createUser("admin@example.com", "HR_ADMIN");
    adminCookie = await loginAs(app, "admin@example.com");
  });

  afterEach(async () => {
    await cleanupStorage();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedArchivedProjectWithCandidate() {
    const owner = await createUser(`hr-${Math.random().toString(36).slice(2)}@example.com`, "HR_USER");
    const project = await prisma.recruitmentProject.create({ data: { title: "HR Manager", createdBy: owner.id, status: "ARCHIVED" } });
    await prisma.auditLog.create({
      data: {
        actorId: owner.id, action: "PROJECT_STATUS_CHANGED", entityType: "RecruitmentProject", entityId: project.id,
        afterJson: { status: "ARCHIVED" }, createdAt: new Date(Date.now() - 400 * 24 * 60 * 60 * 1000),
      },
    });
    const candidate = await prisma.candidate.create({ data: { fullName: "Jane Doe", normalizedEmail: "jane@example.com" } });
    await prisma.candidateProjectLink.create({ data: { candidateId: candidate.id, projectId: project.id, anonymizedLabel: "Candidate #001" } });
    await prisma.candidateDocument.create({
      data: { candidateId: candidate.id, projectId: project.id, fileType: "pdf", storageKey: "s3://bucket/key.pdf", originalFilename: "resume.pdf", uploadedBy: owner.id, status: "COMPLETED" },
    });
    return { owner, project, candidate };
  }

  it("purges an eligible candidate and returns no PII in the response", async () => {
    const { candidate } = await seedArchivedProjectWithCandidate();
    const res = await app.inject({ method: "POST", url: `/admin/candidates/${candidate.id}/purge`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ candidateId: candidate.id, status: "PURGED", documentCount: 1 });
    expect(res.body).not.toContain("Jane Doe");
    expect(res.body).not.toContain("jane@example.com");
  });

  it("returns 409 for a non-eligible candidate, without purging it", async () => {
    const owner = await createUser("hr-active@example.com", "HR_USER");
    const project = await prisma.recruitmentProject.create({ data: { title: "Active Project", createdBy: owner.id, status: "ACTIVE" } });
    const candidate = await prisma.candidate.create({ data: { fullName: "Jane Doe" } });
    await prisma.candidateProjectLink.create({ data: { candidateId: candidate.id, projectId: project.id, anonymizedLabel: "Candidate #001" } });

    const res = await app.inject({ method: "POST", url: `/admin/candidates/${candidate.id}/purge`, headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("not_eligible");
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).piiPurgedAt).toBeNull();
  });

  it("returns 404 for a nonexistent candidate", async () => {
    const res = await app.inject({ method: "POST", url: "/admin/candidates/does-not-exist/purge", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(404);
  });

  it("is idempotent: a second purge request on an already-purged candidate returns ALREADY_PURGED, not an error", async () => {
    const { candidate } = await seedArchivedProjectWithCandidate();
    await app.inject({ method: "POST", url: `/admin/candidates/${candidate.id}/purge`, headers: { cookie: adminCookie } });

    const second = await app.inject({ method: "POST", url: `/admin/candidates/${candidate.id}/purge`, headers: { cookie: adminCookie } });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ candidateId: candidate.id, status: "ALREADY_PURGED" });
  });

  it("lists purge-eligible candidates as ids/counts only — no PII", async () => {
    const { candidate } = await seedArchivedProjectWithCandidate();
    const res = await app.inject({ method: "GET", url: "/admin/candidates/purge-eligible", headers: { cookie: adminCookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.candidateIds).toContain(candidate.id);
    expect(body.count).toBe(body.candidateIds.length);
    expect(res.body).not.toContain("Jane Doe");
  });

  it("denies both endpoints to a non-admin HR_USER (403)", async () => {
    const { candidate } = await seedArchivedProjectWithCandidate();
    const hrUser = await createUser("plain-hr@example.com", "HR_USER");
    const hrCookie = await loginAs(app, hrUser.email);

    const listRes = await app.inject({ method: "GET", url: "/admin/candidates/purge-eligible", headers: { cookie: hrCookie } });
    expect(listRes.statusCode).toBe(403);
    const purgeRes = await app.inject({ method: "POST", url: `/admin/candidates/${candidate.id}/purge`, headers: { cookie: hrCookie } });
    expect(purgeRes.statusCode).toBe(403);
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).piiPurgedAt).toBeNull();
  });

  it("allows SYSTEM_ADMIN through both endpoints", async () => {
    const { candidate } = await seedArchivedProjectWithCandidate();
    const sysadmin = await createUser("sysadmin@example.com", "SYSTEM_ADMIN");
    const sysadminCookie = await loginAs(app, sysadmin.email);

    const listRes = await app.inject({ method: "GET", url: "/admin/candidates/purge-eligible", headers: { cookie: sysadminCookie } });
    expect(listRes.statusCode).toBe(200);
    const purgeRes = await app.inject({ method: "POST", url: `/admin/candidates/${candidate.id}/purge`, headers: { cookie: sysadminCookie } });
    expect(purgeRes.statusCode).toBe(200);
  });
});

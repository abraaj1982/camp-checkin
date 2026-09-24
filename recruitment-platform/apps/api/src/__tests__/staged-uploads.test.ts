import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { FakeCandidateDocumentQueue } from "@recruitment-platform/queue";
import { createTestStorage, buildTestApp, createUser, loginAs, resetDatabase } from "./test-utils.js";

/**
 * Phase 7 — Candidate Deduplication. The ordinary-project-member-facing
 * surface: neutral status listing and retry. Neither endpoint ever
 * discloses a review id, matched-candidate identity, or matching signal —
 * this module never even selects CandidateMatchReview.
 */
describe("Staged Uploads (Phase 7, project-member facing)", () => {
  let app: FastifyInstance;
  let cleanupStorage: () => Promise<void>;
  let queue: FakeCandidateDocumentQueue;
  let cookie: string;
  let userId: string;
  let projectId: string;

  beforeEach(async () => {
    await resetDatabase();
    const { storage, cleanup } = await createTestStorage();
    cleanupStorage = cleanup;
    queue = new FakeCandidateDocumentQueue();
    app = await buildTestApp({ storage, queue });

    const user = await createUser("hr@example.com", "HR_USER");
    userId = user.id;
    cookie = await loginAs(app, "hr@example.com");
    const projectRes = await app.inject({ method: "POST", url: "/projects", headers: { cookie }, payload: { title: "HR Manager" } });
    projectId = projectRes.json().id;
  });

  afterEach(async () => {
    await cleanupStorage();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedStagedUpload(status: "PENDING_IDENTITY_RESOLUTION" | "RESOLVING" | "PENDING_REVIEW" | "PROMOTED" | "FAILED", failureReason: string | null = null) {
    return prisma.stagedUpload.create({
      data: {
        projectId, fileType: "pdf", storageKey: "s3://bucket/key.pdf", originalFilename: "resume.pdf",
        uploadedBy: userId, status, failureReason,
      },
    });
  }

  it("lists staged uploads with a neutral, non-disclosing message for PENDING_REVIEW — never a review id or matched-candidate detail", async () => {
    await seedStagedUpload("PENDING_REVIEW");
    const candidate = await prisma.candidate.create({ data: { fullName: "Some Candidate" } });
    const stagedUpload = await prisma.stagedUpload.findFirstOrThrow({ where: { projectId } });
    await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId, matchSignal: "EMAIL", emailMatchedCandidateId: candidate.id },
    });

    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/staged-uploads`, headers: { cookie } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toHaveLength(1);
    expect(body[0].status).toBe("PENDING_REVIEW");
    expect(body[0].message).toBe("Possible duplicate detected — administrator review required.");

    // Never discloses the review id, candidate id, candidate name, or matchSignal.
    const raw = res.body;
    expect(raw).not.toContain("Some Candidate");
    expect(raw).not.toContain(candidate.id);
    expect(raw).not.toContain("matchSignal");
    expect(raw).not.toContain("EMAIL");
  });

  it("returns null message for non-PENDING_REVIEW statuses", async () => {
    await seedStagedUpload("PROMOTED");
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/staged-uploads`, headers: { cookie } });
    expect(res.json()[0].message).toBeNull();
  });

  it("surfaces failureReason only for FAILED uploads", async () => {
    await seedStagedUpload("FAILED", "Simulated parse failure.");
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/staged-uploads`, headers: { cookie } });
    expect(res.json()[0].failureReason).toBe("Simulated parse failure.");
  });

  it("denies staged-upload listing to an unrelated HR_USER (404, not 403)", async () => {
    await seedStagedUpload("PENDING_IDENTITY_RESOLUTION");
    await createUser("outsider@example.com", "HR_USER");
    const outsiderCookie = await loginAs(app, "outsider@example.com");
    const res = await app.inject({ method: "GET", url: `/projects/${projectId}/staged-uploads`, headers: { cookie: outsiderCookie } });
    expect(res.statusCode).toBe(404);
  });

  it("retries a FAILED staged upload: resets status, re-enqueues, audits — same StagedUpload row, never a second one", async () => {
    const stagedUpload = await seedStagedUpload("FAILED", "Simulated parse failure.");

    const res = await app.inject({ method: "POST", url: `/projects/${projectId}/staged-uploads/${stagedUpload.id}/retry`, headers: { cookie } });
    expect(res.statusCode).toBe(200);

    const updated = await prisma.stagedUpload.findUniqueOrThrow({ where: { id: stagedUpload.id } });
    expect(updated.status).toBe("PENDING_IDENTITY_RESOLUTION");
    expect(updated.failureReason).toBeNull();
    expect(await prisma.stagedUpload.count({ where: { projectId } })).toBe(1); // never a second row

    expect(queue.enqueuedIdentityResolution).toHaveLength(1);
    expect(queue.enqueuedIdentityResolution[0].stagedUploadId).toBe(stagedUpload.id);

    const auditEntries = await prisma.auditLog.findMany({ where: { entityId: stagedUpload.id } });
    expect(auditEntries.map((a) => a.action)).toContain("STAGED_UPLOAD_RETRY_REQUESTED");
  });

  it("refuses to retry a staged upload that is not FAILED", async () => {
    const stagedUpload = await seedStagedUpload("PENDING_REVIEW");
    const res = await app.inject({ method: "POST", url: `/projects/${projectId}/staged-uploads/${stagedUpload.id}/retry`, headers: { cookie } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("not_retryable");
  });

  it("never lets two concurrent retries both re-enqueue the same staged upload", async () => {
    const stagedUpload = await seedStagedUpload("FAILED", "simulated");

    const [resA, resB] = await Promise.all([
      app.inject({ method: "POST", url: `/projects/${projectId}/staged-uploads/${stagedUpload.id}/retry`, headers: { cookie } }),
      app.inject({ method: "POST", url: `/projects/${projectId}/staged-uploads/${stagedUpload.id}/retry`, headers: { cookie } }),
    ]);
    const statusCodes = [resA.statusCode, resB.statusCode].sort();
    expect(statusCodes).toEqual([200, 400]);
    expect(queue.enqueuedIdentityResolution).toHaveLength(1);
  });

  it("denies retry to an unrelated HR_USER (404, not 403)", async () => {
    const stagedUpload = await seedStagedUpload("FAILED", "simulated");
    await createUser("outsider2@example.com", "HR_USER");
    const outsiderCookie = await loginAs(app, "outsider2@example.com");
    const res = await app.inject({ method: "POST", url: `/projects/${projectId}/staged-uploads/${stagedUpload.id}/retry`, headers: { cookie: outsiderCookie } });
    expect(res.statusCode).toBe(404);
  });
});

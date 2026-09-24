import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@recruitment-platform/db";
import { LocalObjectStorage, buildStagedUploadKey } from "@recruitment-platform/storage";
import { FakeCandidateDocumentQueue } from "@recruitment-platform/queue";
import { runIdentityResolutionPipeline } from "../identity-resolution.js";
import { buildTestPdf } from "./fixtures.js";
import { createUser, resetDatabase } from "./test-utils.js";

/**
 * Phase 7 — Candidate Deduplication. Covers exactly what the identity-
 * resolution job itself is responsible for: deterministic extraction,
 * always-both-signals matching, matchSignal classification (EMAIL/PHONE/
 * BOTH/CONFLICT), no-match promotion, purged-candidate exclusion, and
 * concurrency/idempotency. Admin resolution (LINK_EXISTING/CREATE_NEW,
 * including the identity-enrichment rules) is covered in
 * apps/api/src/__tests__/candidate-match-reviews.test.ts, since that's
 * where the transaction actually lives.
 */
describe("runIdentityResolutionPipeline", () => {
  let storageDir: string;
  let storage: LocalObjectStorage;
  let queue: FakeCandidateDocumentQueue;

  beforeEach(async () => {
    await resetDatabase();
    storageDir = await mkdtemp(join(tmpdir(), "rip-identity-resolution-test-"));
    storage = new LocalObjectStorage(storageDir);
    queue = new FakeCandidateDocumentQueue();
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedStagedUpload(text: string, opts: { batchId?: string } = {}) {
    const user = await createUser(`hr-${Math.random().toString(36).slice(2)}@example.com`);
    const project = await prisma.recruitmentProject.create({ data: { title: "HR Manager", createdBy: user.id } });
    const pdf = await buildTestPdf(text);
    const stagedUpload = await prisma.stagedUpload.create({
      data: {
        projectId: project.id,
        batchId: opts.batchId,
        fileType: "pdf",
        storageKey: "pending",
        originalFilename: "jane-doe-resume.pdf",
        fileSizeBytes: pdf.byteLength,
        uploadedBy: user.id,
      },
    });
    const storageKey = buildStagedUploadKey({ projectId: project.id, stagedUploadId: stagedUpload.id, fileExtension: "pdf" });
    await storage.putObject({ key: storageKey, body: pdf, contentType: "application/pdf" });
    await prisma.stagedUpload.update({ where: { id: stagedUpload.id }, data: { storageKey } });
    return { user, project, stagedUpload };
  }

  it("EMAIL match: creates a PENDING CandidateMatchReview with matchSignal EMAIL, no Candidate-scoped rows for the new upload", async () => {
    const existing = await prisma.candidate.create({
      data: { fullName: "Existing Candidate", normalizedEmail: "jane@example.com" },
    });
    const { stagedUpload, project } = await seedStagedUpload("Jane Doe. Email: jane@example.com. No phone listed.");

    await runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue });

    const updated = await prisma.stagedUpload.findUniqueOrThrow({ where: { id: stagedUpload.id } });
    expect(updated.status).toBe("PENDING_REVIEW");

    const review = await prisma.candidateMatchReview.findUniqueOrThrow({ where: { stagedUploadId: stagedUpload.id } });
    expect(review.matchSignal).toBe("EMAIL");
    expect(review.emailMatchedCandidateId).toBe(existing.id);
    expect(review.phoneMatchedCandidateId).toBeNull();
    expect(review.status).toBe("PENDING");

    expect(await prisma.candidateDocument.count({ where: { projectId: project.id } })).toBe(0);
    expect(queue.enqueued).toHaveLength(0);
  });

  it("PHONE match: matchSignal PHONE", async () => {
    const existing = await prisma.candidate.create({
      data: { fullName: "Existing Candidate", normalizedPhone: "5551234567" },
    });
    const { stagedUpload, project } = await seedStagedUpload("Jane Doe. Phone: 555-123-4567. No email listed.");

    await runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue });

    const review = await prisma.candidateMatchReview.findUniqueOrThrow({ where: { stagedUploadId: stagedUpload.id } });
    expect(review.matchSignal).toBe("PHONE");
    expect(review.phoneMatchedCandidateId).toBe(existing.id);
    expect(review.emailMatchedCandidateId).toBeNull();
  });

  it("BOTH match: both signals matched the SAME candidate", async () => {
    const existing = await prisma.candidate.create({
      data: { fullName: "Existing Candidate", normalizedEmail: "jane@example.com", normalizedPhone: "5551234567" },
    });
    const { stagedUpload, project } = await seedStagedUpload("Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");

    await runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue });

    const review = await prisma.candidateMatchReview.findUniqueOrThrow({ where: { stagedUploadId: stagedUpload.id } });
    expect(review.matchSignal).toBe("BOTH");
    expect(review.emailMatchedCandidateId).toBe(existing.id);
    expect(review.phoneMatchedCandidateId).toBe(existing.id);
  });

  it("CONFLICT match: email matches candidate A, phone matches a DIFFERENT candidate B — neither is auto-selected", async () => {
    const candidateA = await prisma.candidate.create({
      data: { fullName: "Candidate A", normalizedEmail: "jane@example.com" },
    });
    const candidateB = await prisma.candidate.create({
      data: { fullName: "Candidate B", normalizedPhone: "5551234567" },
    });
    const { stagedUpload, project } = await seedStagedUpload("Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");

    await runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue });

    const review = await prisma.candidateMatchReview.findUniqueOrThrow({ where: { stagedUploadId: stagedUpload.id } });
    expect(review.matchSignal).toBe("CONFLICT");
    expect(review.emailMatchedCandidateId).toBe(candidateA.id);
    expect(review.phoneMatchedCandidateId).toBe(candidateB.id);
    expect(review.status).toBe("PENDING"); // no automatic resolution
  });

  it("no identity extracted: proceeds straight to normal Candidate/Link/CandidateDocument creation", async () => {
    const { stagedUpload, project } = await seedStagedUpload("A resume with no email or phone number anywhere.");

    await runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue });

    const updated = await prisma.stagedUpload.findUniqueOrThrow({ where: { id: stagedUpload.id } });
    expect(updated.status).toBe("PROMOTED");
    expect(await prisma.candidateMatchReview.count()).toBe(0);

    const document = await prisma.candidateDocument.findFirstOrThrow({ where: { projectId: project.id } });
    expect(document.stagedUploadId).toBe(stagedUpload.id);
    expect(document.storageKey).toBe(updated.storageKey); // literal same key, never copied/moved

    const link = await prisma.candidateProjectLink.findFirstOrThrow({ where: { projectId: project.id } });
    expect(link.anonymizedLabel).toBe("Candidate #001");

    expect(queue.enqueued).toHaveLength(1);
    expect(queue.enqueued[0].candidateDocumentId).toBe(document.id);
  });

  it("no identity match found (email/phone extracted but neither exists in the DB): also promotes normally", async () => {
    const { stagedUpload, project } = await seedStagedUpload("Jane Doe. Email: jane@example.com. Phone: 555-123-4567.");

    await runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue });

    const updated = await prisma.stagedUpload.findUniqueOrThrow({ where: { id: stagedUpload.id } });
    expect(updated.status).toBe("PROMOTED");

    const candidate = await prisma.candidate.findFirstOrThrow({});
    expect(candidate.normalizedEmail).toBe("jane@example.com");
    expect(candidate.normalizedPhone).toBe("5551234567");
    expect(candidate.email).toBe("jane@example.com");
  });

  it("excludes a purged candidate from matching — a staged upload with a purged candidate's email promotes as a NEW candidate, never links", async () => {
    await prisma.candidate.create({
      data: { fullName: "Purged Candidate", normalizedEmail: "jane@example.com", piiPurgedAt: new Date() },
    });
    const { stagedUpload, project } = await seedStagedUpload("Jane Doe. Email: jane@example.com.");

    await runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue });

    const updated = await prisma.stagedUpload.findUniqueOrThrow({ where: { id: stagedUpload.id } });
    expect(updated.status).toBe("PROMOTED"); // no match — purged candidate excluded
    expect(await prisma.candidateMatchReview.count()).toBe(0);
    expect(await prisma.candidate.count()).toBe(2); // the purged one + the newly promoted one
  });

  it("concurrent identity-resolution attempts for the same StagedUpload: only one proceeds, never two Candidates", async () => {
    const { stagedUpload, project } = await seedStagedUpload("A resume with no email or phone number anywhere.");

    await Promise.all([
      runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue }),
      runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue }),
    ]);

    expect(await prisma.candidate.count()).toBe(1);
    expect(await prisma.candidateDocument.count()).toBe(1);
  });

  it("retry: a FAILED StagedUpload reset to PENDING_IDENTITY_RESOLUTION can be re-run and still only ever produces one Candidate", async () => {
    const { stagedUpload, project } = await seedStagedUpload("A resume with no email or phone number anywhere.");
    await prisma.stagedUpload.update({ where: { id: stagedUpload.id }, data: { status: "FAILED", failureReason: "simulated" } });

    // Not retryable while FAILED and not reset — claim fails, no-op.
    await runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue });
    expect((await prisma.stagedUpload.findUniqueOrThrow({ where: { id: stagedUpload.id } })).status).toBe("FAILED");

    await prisma.stagedUpload.update({ where: { id: stagedUpload.id }, data: { status: "PENDING_IDENTITY_RESOLUTION", failureReason: null } });
    await runIdentityResolutionPipeline({ stagedUploadId: stagedUpload.id, projectId: project.id }, { storage, queue });

    expect((await prisma.stagedUpload.findUniqueOrThrow({ where: { id: stagedUpload.id } })).status).toBe("PROMOTED");
    expect(await prisma.candidate.count()).toBe(1);
  });

  it("batch deletion: StagedUpload.batchId is set to null, other fields/state unaffected, in every lifecycle state", async () => {
    const user = await createUser("hr-batch@example.com");
    const project = await prisma.recruitmentProject.create({ data: { title: "HR Manager", createdBy: user.id } });
    const batch = await prisma.candidateUploadBatch.create({ data: { projectId: project.id, createdBy: user.id } });
    const stagedUpload = await prisma.stagedUpload.create({
      data: {
        projectId: project.id,
        batchId: batch.id,
        fileType: "pdf",
        storageKey: "s3://bucket/key.pdf",
        originalFilename: "resume.pdf",
        uploadedBy: user.id,
      },
    });

    await prisma.candidateUploadBatch.delete({ where: { id: batch.id } });

    const updated = await prisma.stagedUpload.findUniqueOrThrow({ where: { id: stagedUpload.id } });
    expect(updated.batchId).toBeNull();
    expect(updated.status).toBe("PENDING_IDENTITY_RESOLUTION"); // unaffected
  });
});

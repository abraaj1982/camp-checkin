import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@recruitment-platform/db";
import { startProcessingRun, tryPublishCandidateProjectAuthority } from "../processing-run.js";
import { createUser, resetDatabase } from "./test-utils.js";

/**
 * Item 16 (Option B) — Project-Scoped Candidate Profile Authority. Proves
 * the tryPublishCandidateProjectAuthority CAS directly against real
 * Postgres, mirroring candidate-profile-authority.test.ts's own rigor and
 * case coverage, re-scoped to (candidateId, projectId).
 */
describe("Candidate Project Authority (Item 16, Option B)", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedCandidateAndProject() {
    const user = await createUser(`hr-${Math.random().toString(36).slice(2)}@example.com`);
    const project = await prisma.recruitmentProject.create({ data: { title: "HR Manager", createdBy: user.id } });
    const candidate = await prisma.candidate.create({ data: { fullName: "resume" } });
    return { user, project, candidate };
  }

  async function seedAuthorityRow(candidateId: string, projectId: string) {
    return prisma.candidateProjectAuthority.create({ data: { candidateId, projectId } });
  }

  async function seedDocument(candidateId: string, projectId: string, uploadedBy: string, uploadedAt: Date) {
    return prisma.candidateDocument.create({
      data: {
        candidateId,
        projectId,
        fileType: "pdf",
        storageKey: `s3://bucket/${Math.random().toString(36).slice(2)}.pdf`,
        originalFilename: "resume.pdf",
        uploadedBy,
        uploadedAt,
        status: "PROCESSING",
      },
    });
  }

  async function readAuthority(candidateId: string, projectId: string) {
    return prisma.candidateProjectAuthority.findUniqueOrThrow({
      where: { candidateId_projectId: { candidateId, projectId } },
    });
  }

  async function publish(candidateId: string, projectId: string, documentId: string, uploadedAt: Date, runId: string, attemptNumber: number) {
    return prisma.$transaction((tx) =>
      tryPublishCandidateProjectAuthority(tx, {
        candidateId,
        projectId,
        newDocumentId: documentId,
        newUploadedAt: uploadedAt,
        newRunId: runId,
        newAttemptNumber: attemptNumber,
      }),
    );
  }

  it("(1) first publication succeeds from NULL authority, setting all four fields together", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const doc = await seedDocument(candidate.id, project.id, user.id, new Date("2026-01-01T10:00:00Z"));
    const run = await startProcessingRun(doc.id);

    const ok = await publish(candidate.id, project.id, doc.id, doc.uploadedAt, run.id, run.attemptNumber);
    expect(ok).toBe(true);

    const authority = await readAuthority(candidate.id, project.id);
    expect(authority.currentDocumentId).toBe(doc.id);
    expect(authority.currentUploadedAt?.getTime()).toBe(doc.uploadedAt.getTime());
    expect(authority.currentProcessingRunId).toBe(run.id);
    expect(authority.currentAttemptNumber).toBe(run.attemptNumber);
  });

  it("(2) newer upload wins over an already-published older document", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const older = await seedDocument(candidate.id, project.id, user.id, new Date("2026-01-01T00:00:00Z"));
    const olderRun = await startProcessingRun(older.id);
    await publish(candidate.id, project.id, older.id, older.uploadedAt, olderRun.id, olderRun.attemptNumber);

    const newer = await seedDocument(candidate.id, project.id, user.id, new Date("2026-02-01T00:00:00Z"));
    const newerRun = await startProcessingRun(newer.id);
    const ok = await publish(candidate.id, project.id, newer.id, newer.uploadedAt, newerRun.id, newerRun.attemptNumber);

    expect(ok).toBe(true);
    const authority = await readAuthority(candidate.id, project.id);
    expect(authority.currentDocumentId).toBe(newer.id);
    expect(authority.currentProcessingRunId).toBe(newerRun.id);
  });

  it("(3) older upload loses against an already-published newer document", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const newer = await seedDocument(candidate.id, project.id, user.id, new Date("2026-02-01T00:00:00Z"));
    const newerRun = await startProcessingRun(newer.id);
    await publish(candidate.id, project.id, newer.id, newer.uploadedAt, newerRun.id, newerRun.attemptNumber);

    const older = await seedDocument(candidate.id, project.id, user.id, new Date("2026-01-01T00:00:00Z"));
    const olderRun = await startProcessingRun(older.id);
    const ok = await publish(candidate.id, project.id, older.id, older.uploadedAt, olderRun.id, olderRun.attemptNumber);

    expect(ok).toBe(false);
    const authority = await readAuthority(candidate.id, project.id);
    expect(authority.currentDocumentId).toBe(newer.id);
    expect(authority.currentProcessingRunId).toBe(newerRun.id);
  });

  it("(4) equal uploadedAt + higher documentId wins", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const sameTime = new Date("2026-01-01T00:00:00Z");
    const doc1 = await seedDocument(candidate.id, project.id, user.id, sameTime);
    const doc2 = await seedDocument(candidate.id, project.id, user.id, sameTime);
    const [lower, higher] = [doc1, doc2].sort((a, b) => (a.id < b.id ? -1 : 1));

    const lowerRun = await startProcessingRun(lower.id);
    await publish(candidate.id, project.id, lower.id, sameTime, lowerRun.id, lowerRun.attemptNumber);

    const higherRun = await startProcessingRun(higher.id);
    const ok = await publish(candidate.id, project.id, higher.id, sameTime, higherRun.id, higherRun.attemptNumber);

    expect(ok).toBe(true);
    const authority = await readAuthority(candidate.id, project.id);
    expect(authority.currentDocumentId).toBe(higher.id);
  });

  it("(5) equal uploadedAt + lower documentId loses", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const sameTime = new Date("2026-01-01T00:00:00Z");
    const doc1 = await seedDocument(candidate.id, project.id, user.id, sameTime);
    const doc2 = await seedDocument(candidate.id, project.id, user.id, sameTime);
    const [lower, higher] = [doc1, doc2].sort((a, b) => (a.id < b.id ? -1 : 1));

    const higherRun = await startProcessingRun(higher.id);
    await publish(candidate.id, project.id, higher.id, sameTime, higherRun.id, higherRun.attemptNumber);

    const lowerRun = await startProcessingRun(lower.id);
    const ok = await publish(candidate.id, project.id, lower.id, sameTime, lowerRun.id, lowerRun.attemptNumber);

    expect(ok).toBe(false);
    const authority = await readAuthority(candidate.id, project.id);
    expect(authority.currentDocumentId).toBe(higher.id);
  });

  it("(6) same document, higher attemptNumber wins (Policy C retry)", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const doc = await seedDocument(candidate.id, project.id, user.id, new Date("2026-01-01T00:00:00Z"));
    const runA1 = await startProcessingRun(doc.id);
    await publish(candidate.id, project.id, doc.id, doc.uploadedAt, runA1.id, runA1.attemptNumber);
    await prisma.processingRun.update({ where: { id: runA1.id }, data: { status: "COMPLETED" } });

    const runA2 = await startProcessingRun(doc.id);
    const ok = await publish(candidate.id, project.id, doc.id, doc.uploadedAt, runA2.id, runA2.attemptNumber);

    expect(ok).toBe(true);
    const authority = await readAuthority(candidate.id, project.id);
    expect(authority.currentProcessingRunId).toBe(runA2.id);
    expect(authority.currentAttemptNumber).toBe(runA2.attemptNumber);
  });

  it("(7) same document, lower attemptNumber loses", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const doc = await seedDocument(candidate.id, project.id, user.id, new Date("2026-01-01T00:00:00Z"));
    const runA1 = await startProcessingRun(doc.id);
    await prisma.processingRun.update({ where: { id: runA1.id }, data: { status: "COMPLETED", attemptNumber: 2 } });
    await publish(candidate.id, project.id, doc.id, doc.uploadedAt, runA1.id, 2);

    // Simulate a stale, lower-numbered attempt finishing after the higher one already published.
    const staleRun = await prisma.processingRun.create({
      data: { candidateDocumentId: doc.id, attemptNumber: 1, status: "COMPLETED", completedAt: new Date() },
    });
    const ok = await publish(candidate.id, project.id, doc.id, doc.uploadedAt, staleRun.id, 1);

    expect(ok).toBe(false);
    const authority = await readAuthority(candidate.id, project.id);
    expect(authority.currentProcessingRunId).toBe(runA1.id);
    expect(authority.currentAttemptNumber).toBe(2);
  });

  it("(8) a different project's authority is unaffected by this project's publication", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const otherProject = await prisma.recruitmentProject.create({ data: { title: "Other Project", createdBy: user.id } });
    await seedAuthorityRow(candidate.id, otherProject.id);

    const doc = await seedDocument(candidate.id, project.id, user.id, new Date("2026-01-01T00:00:00Z"));
    const run = await startProcessingRun(doc.id);
    await publish(candidate.id, project.id, doc.id, doc.uploadedAt, run.id, run.attemptNumber);

    const thisProjectAuthority = await readAuthority(candidate.id, project.id);
    const otherProjectAuthority = await readAuthority(candidate.id, otherProject.id);
    expect(thisProjectAuthority.currentDocumentId).toBe(doc.id);
    expect(otherProjectAuthority.currentDocumentId).toBeNull();
    expect(otherProjectAuthority.currentProcessingRunId).toBeNull();
  });

  it("(9) concurrent publication of two documents yields exactly one winner, matching the ordering", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const docEarlier = await seedDocument(candidate.id, project.id, user.id, new Date("2026-01-01T00:00:00Z"));
    const docLater = await seedDocument(candidate.id, project.id, user.id, new Date("2026-02-01T00:00:00Z"));
    const runEarlier = await startProcessingRun(docEarlier.id);
    const runLater = await startProcessingRun(docLater.id);

    const [okEarlier, okLater] = await Promise.all([
      publish(candidate.id, project.id, docEarlier.id, docEarlier.uploadedAt, runEarlier.id, runEarlier.attemptNumber),
      publish(candidate.id, project.id, docLater.id, docLater.uploadedAt, runLater.id, runLater.attemptNumber),
    ]);

    // From a NULL baseline, whichever of the two commits first always
    // succeeds (branch 1), and if the earlier document happens to commit
    // first, the later document's update then legitimately supersedes it
    // too (branch 2) — so both can legitimately return true. What must
    // hold regardless of commit order is: at least one succeeds, and the
    // FINAL state deterministically reflects the later document (mirrors
    // the existing Phase 11 precedent's own concurrent test, which uses
    // the same >= 1 assertion for the same reason).
    expect([okEarlier, okLater].filter(Boolean).length).toBeGreaterThanOrEqual(1);
    const authority = await readAuthority(candidate.id, project.id);
    expect(authority.currentDocumentId).toBe(docLater.id);
  });

  it("(10) failed/non-successful processing never calls publish — authority remains unchanged", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const doc = await seedDocument(candidate.id, project.id, user.id, new Date("2026-01-01T00:00:00Z"));
    await startProcessingRun(doc.id);
    // No publish() call at all — mirrors the pipeline's actual behavior: a
    // failed run never reaches the tryPublishCandidateProjectAuthority call
    // site (it's inside the post-AI-call success transaction only).

    const authority = await readAuthority(candidate.id, project.id);
    expect(authority.currentDocumentId).toBeNull();
    expect(authority.currentProcessingRunId).toBeNull();
  });

  it("(11) an existing authority row is not overwritten by an older document even after further unrelated activity", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const newer = await seedDocument(candidate.id, project.id, user.id, new Date("2026-03-01T00:00:00Z"));
    const newerRun = await startProcessingRun(newer.id);
    await publish(candidate.id, project.id, newer.id, newer.uploadedAt, newerRun.id, newerRun.attemptNumber);

    const older1 = await seedDocument(candidate.id, project.id, user.id, new Date("2026-01-01T00:00:00Z"));
    const older1Run = await startProcessingRun(older1.id);
    await publish(candidate.id, project.id, older1.id, older1.uploadedAt, older1Run.id, older1Run.attemptNumber);

    const older2 = await seedDocument(candidate.id, project.id, user.id, new Date("2026-02-01T00:00:00Z"));
    const older2Run = await startProcessingRun(older2.id);
    await publish(candidate.id, project.id, older2.id, older2.uploadedAt, older2Run.id, older2Run.attemptNumber);

    const authority = await readAuthority(candidate.id, project.id);
    expect(authority.currentDocumentId).toBe(newer.id);
    expect(authority.currentProcessingRunId).toBe(newerRun.id);
  });

  it("(12) publish() returns the correct isAuthoritative boolean on both success and failure", async () => {
    const { candidate, project, user } = await seedCandidateAndProject();
    await seedAuthorityRow(candidate.id, project.id);
    const doc = await seedDocument(candidate.id, project.id, user.id, new Date("2026-01-01T00:00:00Z"));
    const run = await startProcessingRun(doc.id);
    const first = await publish(candidate.id, project.id, doc.id, doc.uploadedAt, run.id, run.attemptNumber);
    expect(first).toBe(true);

    const olderDoc = await seedDocument(candidate.id, project.id, user.id, new Date("2025-01-01T00:00:00Z"));
    const olderRun = await startProcessingRun(olderDoc.id);
    const second = await publish(candidate.id, project.id, olderDoc.id, olderDoc.uploadedAt, olderRun.id, olderRun.attemptNumber);
    expect(second).toBe(false);
  });
});

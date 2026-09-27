import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@recruitment-platform/db";
import { LocalObjectStorage } from "@recruitment-platform/storage";
import {
  isCandidateEligibleForPurge,
  findEligibleCandidateIds,
  executeCandidatePurge,
  recoverInterruptedPurges,
  runScheduledPurgeScan,
  DEFAULT_RETENTION_DAYS,
} from "../candidate-purge.js";
import { createUser, resetDatabase } from "./test-utils.js";
import type { ObjectStorage, PutObjectInput } from "@recruitment-platform/storage";

/** Wraps a real ObjectStorage but throws deleteObject for configured keys — for testing per-document failure isolation (Phase 8C fix). */
class FlakyObjectStorage implements ObjectStorage {
  readonly name = "flaky";
  constructor(
    private readonly inner: ObjectStorage,
    private readonly failingKeys: Set<string>,
  ) {}
  putObject(input: PutObjectInput) {
    return this.inner.putObject(input);
  }
  getObject(key: string) {
    return this.inner.getObject(key);
  }
  async deleteObject(key: string): Promise<void> {
    if (this.failingKeys.has(key)) throw new Error(`Simulated storage failure for ${key}`);
    return this.inner.deleteObject(key);
  }
}

const PAST_TERMINAL_ENTRY = new Date(Date.now() - (DEFAULT_RETENTION_DAYS + 10) * 24 * 60 * 60 * 1000);
const RECENT_TERMINAL_ENTRY = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago — retention not yet elapsed

describe("Phase 8 — PII Retention/Purge", () => {
  let storageDir: string;
  let storage: LocalObjectStorage;

  beforeEach(async () => {
    await resetDatabase();
    storageDir = await mkdtemp(join(tmpdir(), "rip-purge-test-storage-"));
    storage = new LocalObjectStorage(storageDir);
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedProject(status: string, opts: { retentionDays?: number | null; terminalEnteredAt?: Date } = {}) {
    const user = await createUser(`hr-${Math.random().toString(36).slice(2)}@example.com`);
    const project = await prisma.recruitmentProject.create({
      data: { title: "HR Manager", createdBy: user.id, status: status as never, retentionDays: opts.retentionDays },
    });
    if (status === "COMPLETED" || status === "ARCHIVED") {
      await prisma.auditLog.create({
        data: {
          actorId: user.id,
          action: "PROJECT_STATUS_CHANGED",
          entityType: "RecruitmentProject",
          entityId: project.id,
          afterJson: { status },
          createdAt: opts.terminalEnteredAt ?? PAST_TERMINAL_ENTRY,
        },
      });
    }
    return { user, project };
  }

  async function seedCandidateWithLink(projectId: string, opts: { docStatus?: string } = {}) {
    const candidate = await prisma.candidate.create({
      data: { fullName: "Jane Doe", email: "jane@example.com", phone: "555-123-4567", normalizedEmail: "jane@example.com", normalizedPhone: "5551234567" },
    });
    await prisma.candidateProjectLink.create({
      data: { candidateId: candidate.id, projectId, anonymizedLabel: "Candidate #001" },
    });
    const key = `test/${candidate.id}.pdf`;
    await storage.putObject({ key, body: Buffer.from("dummy pdf"), contentType: "application/pdf" });
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id, projectId, fileType: "pdf", storageKey: key,
        originalFilename: "resume.pdf", uploadedBy: (await prisma.recruitmentProject.findUniqueOrThrow({ where: { id: projectId } })).createdBy,
        status: (opts.docStatus ?? "COMPLETED") as never,
      },
    });
    return { candidate, document };
  }

  // ---- Eligibility: project status ----

  it.each(["ACTIVE", "ON_HOLD", "READY_FOR_CV_UPLOAD"])("candidate in a %s project is NOT eligible", async (status) => {
    const { project } = await seedProject(status);
    const { candidate } = await seedCandidateWithLink(project.id);
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(false);
  });

  it("candidate in a COMPLETED project past retention is eligible", async () => {
    const { project } = await seedProject("COMPLETED");
    const { candidate } = await seedCandidateWithLink(project.id);
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(true);
  });

  it("candidate in an ARCHIVED project past retention is eligible", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate } = await seedCandidateWithLink(project.id);
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(true);
  });

  it("retention boundary: COMPLETED but not enough time elapsed is NOT eligible", async () => {
    const { project } = await seedProject("COMPLETED", { terminalEnteredAt: RECENT_TERMINAL_ENTRY });
    const { candidate } = await seedCandidateWithLink(project.id);
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(false);
  });

  it("retention boundary: a project-level retentionDays override is honored", async () => {
    const { project } = await seedProject("COMPLETED", { retentionDays: 2, terminalEnteredAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) });
    const { candidate } = await seedCandidateWithLink(project.id);
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(true);
  });

  it("invalid retentionDays override (0) fails closed — NOT eligible", async () => {
    const { project } = await seedProject("COMPLETED", { retentionDays: 0 });
    const { candidate } = await seedCandidateWithLink(project.id);
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(false);
  });

  it("invalid retentionDays override (negative) fails closed — NOT eligible", async () => {
    const { project } = await seedProject("COMPLETED", { retentionDays: -5 });
    const { candidate } = await seedCandidateWithLink(project.id);
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(false);
  });

  // ---- Active work protection ----

  it.each(["QUEUED", "PROCESSING", "FAILED_RETRY"])("CandidateDocument with status %s blocks eligibility", async (docStatus) => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate } = await seedCandidateWithLink(project.id, { docStatus });
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(false);
  });

  it("FAILED_NEEDS_OCR does NOT block eligibility", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate } = await seedCandidateWithLink(project.id, { docStatus: "FAILED_NEEDS_OCR" });
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(true);
  });

  it("a RUNNING ProcessingRun blocks eligibility", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate, document } = await seedCandidateWithLink(project.id);
    await prisma.processingRun.create({ data: { candidateDocumentId: document.id, attemptNumber: 1, status: "RUNNING" } });
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(false);
  });

  // ---- Cross-project ----

  it("candidate eligible in one project but active in another is NOT eligible overall", async () => {
    const { project: eligibleProject } = await seedProject("ARCHIVED");
    const { project: activeProject } = await seedProject("ACTIVE");
    const candidate = await prisma.candidate.create({ data: { fullName: "Jane Doe" } });
    await prisma.candidateProjectLink.create({ data: { candidateId: candidate.id, projectId: eligibleProject.id, anonymizedLabel: "Candidate #001" } });
    await prisma.candidateProjectLink.create({ data: { candidateId: candidate.id, projectId: activeProject.id, anonymizedLabel: "Candidate #001" } });
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(false);
  });

  it("candidate linked only to terminal/eligible projects is eligible", async () => {
    const { project: p1 } = await seedProject("ARCHIVED");
    const { project: p2 } = await seedProject("COMPLETED");
    const candidate = await prisma.candidate.create({ data: { fullName: "Jane Doe" } });
    await prisma.candidateProjectLink.create({ data: { candidateId: candidate.id, projectId: p1.id, anonymizedLabel: "Candidate #001" } });
    await prisma.candidateProjectLink.create({ data: { candidateId: candidate.id, projectId: p2.id, anonymizedLabel: "Candidate #001" } });
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(true);
  });

  it("candidate with zero project links is NOT eligible (INDETERMINATE, never vacuously eligible)", async () => {
    const candidate = await prisma.candidate.create({ data: { fullName: "Orphan Candidate" } });
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(false);
  });

  it("an already-purged candidate is NOT eligible again", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate } = await seedCandidateWithLink(project.id);
    await prisma.candidate.update({ where: { id: candidate.id }, data: { piiPurgedAt: new Date() } });
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(false);
  });

  // ---- Pending match review ----

  it("a PENDING CandidateMatchReview referencing the candidate as email match blocks purge", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate } = await seedCandidateWithLink(project.id);
    const other = await seedCandidateWithLink(project.id);
    const stagedUpload = await prisma.stagedUpload.create({
      data: { projectId: project.id, fileType: "pdf", storageKey: "x", originalFilename: "x.pdf", uploadedBy: (await prisma.recruitmentProject.findUniqueOrThrow({ where: { id: project.id } })).createdBy, status: "PENDING_REVIEW" },
    });
    await prisma.candidateMatchReview.create({
      data: { stagedUploadId: stagedUpload.id, projectId: project.id, matchSignal: "EMAIL", emailMatchedCandidateId: candidate.id },
    });
    expect(await isCandidateEligibleForPurge(candidate.id)).toBe(false);
    expect(await isCandidateEligibleForPurge(other.candidate.id)).toBe(true); // unrelated candidate unaffected
  });

  // ---- Purge behavior ----

  it("purge anonymizes Candidate PII, clears normalized fields, sets piiPurgedAt, and preserves the row", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate } = await seedCandidateWithLink(project.id);

    const result = await executeCandidatePurge(candidate.id, "MANUAL", project.createdBy, { storage });
    expect(result.status).toBe("PURGED");

    const purged = await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } });
    expect(purged.fullName).toBe("[purged]");
    expect(purged.email).toBeNull();
    expect(purged.phone).toBeNull();
    expect(purged.normalizedEmail).toBeNull();
    expect(purged.normalizedPhone).toBeNull();
    expect(purged.piiPurgedAt).not.toBeNull();
  });

  it("purge preserves CandidateProjectLink and CandidateDocument rows, deletes the storage object, sets purgedAt, keeps storageKey", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate, document } = await seedCandidateWithLink(project.id);
    const originalStorageKey = document.storageKey;

    await executeCandidatePurge(candidate.id, "MANUAL", project.createdBy, { storage });

    const link = await prisma.candidateProjectLink.findFirstOrThrow({ where: { candidateId: candidate.id } });
    expect(link).toBeTruthy();

    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedDoc.storageKey).toBe(originalStorageKey); // unchanged historical metadata
    expect(updatedDoc.purgedAt).not.toBeNull();

    await expect(storage.getObject(originalStorageKey)).rejects.toBeTruthy();
  });

  it("purge preserves Evidence, Assessment, HrDecision, and CandidateConsistencyFinding unchanged", async () => {
    const { project, user } = await seedProject("ARCHIVED");
    const { candidate, document } = await seedCandidateWithLink(project.id);
    const requirement = await prisma.jobRequirement.create({
      data: { projectId: project.id, category: "FUNCTIONAL_EXPERIENCE", description: "Req", mandatory: true, status: "APPROVED", currentVersionNumber: 1, hrApprovedWeight: 100 },
    });
    const run = await prisma.processingRun.create({ data: { candidateDocumentId: document.id, attemptNumber: 1, status: "COMPLETED", completedAt: new Date() } });
    const assessment = await prisma.assessment.create({
      data: { candidateId: candidate.id, projectId: project.id, requirementId: requirement.id, processingRunId: run.id, aiAssessmentSummary: "x", status: "STRONG_EVIDENCE" },
    });
    const finding = await prisma.candidateConsistencyFinding.create({
      data: { candidateId: candidate.id, projectId: project.id, findingType: "EMPLOYMENT_GAP", severity: "INFORMATION_UNCLEAR", description: "Gap", confidence: "MEDIUM", processingRunId: run.id },
    });
    const decision = await prisma.hrDecision.create({ data: { candidateId: candidate.id, projectId: project.id, decision: "SHORTLIST", decidedBy: user.id } });

    await executeCandidatePurge(candidate.id, "MANUAL", project.createdBy, { storage });

    expect(await prisma.assessment.findUnique({ where: { id: assessment.id } })).toMatchObject({ status: "STRONG_EVIDENCE" });
    expect(await prisma.candidateConsistencyFinding.findUnique({ where: { id: finding.id } })).toMatchObject({ description: "Gap" });
    expect(await prisma.hrDecision.findUnique({ where: { id: decision.id } })).toMatchObject({ decision: "SHORTLIST" });
  });

  it("audit record contains no raw or normalized PII, only ids/counts/metadata", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate } = await seedCandidateWithLink(project.id);

    await executeCandidatePurge(candidate.id, "MANUAL", project.createdBy, { storage });

    const entries = await prisma.auditLog.findMany({ where: { entityType: "Candidate", entityId: candidate.id, action: "CANDIDATE_PII_PURGED" } });
    expect(entries).toHaveLength(1);
    const raw = JSON.stringify(entries[0].afterJson);
    expect(raw).not.toContain("Jane Doe");
    expect(raw).not.toContain("jane@example.com");
    expect(raw).not.toContain("555");
    expect(entries[0].afterJson).toMatchObject({ trigger: "MANUAL", result: "SUCCESS" });
  });

  it("idempotent repeated execution: second call is ALREADY_PURGED, no duplicate audit, PII stays cleared", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate } = await seedCandidateWithLink(project.id);

    const first = await executeCandidatePurge(candidate.id, "MANUAL", project.createdBy, { storage });
    expect(first.status).toBe("PURGED");
    const second = await executeCandidatePurge(candidate.id, "MANUAL", project.createdBy, { storage });
    expect(second.status).toBe("ALREADY_PURGED");

    const entries = await prisma.auditLog.findMany({ where: { entityType: "Candidate", entityId: candidate.id, action: "CANDIDATE_PII_PURGED" } });
    expect(entries).toHaveLength(1);
  });

  it("concurrent manual/scheduled purge attempts on the same candidate: exactly one purges, no duplicate audit", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate } = await seedCandidateWithLink(project.id);

    const [a, b] = await Promise.all([
      executeCandidatePurge(candidate.id, "MANUAL", project.createdBy, { storage }),
      executeCandidatePurge(candidate.id, "SCHEDULED", null, { storage }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(["ALREADY_PURGED", "PURGED"]);

    const entries = await prisma.auditLog.findMany({ where: { entityType: "Candidate", entityId: candidate.id, action: "CANDIDATE_PII_PURGED" } });
    expect(entries).toHaveLength(1);
  });

  it("NOT_ELIGIBLE is returned (not silently purged) for an active candidate", async () => {
    const { project } = await seedProject("ACTIVE");
    const { candidate } = await seedCandidateWithLink(project.id);
    const result = await executeCandidatePurge(candidate.id, "MANUAL", project.createdBy, { storage });
    expect(result.status).toBe("NOT_ELIGIBLE");
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).piiPurgedAt).toBeNull();
  });

  // ---- Storage failure / interrupted recovery ----

  it("recovers a purge interrupted between DB commit and storage deletion (purgedAt still null, Candidate already purged)", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate, document } = await seedCandidateWithLink(project.id);

    // Simulate Step 1 having committed without Step 2 ever running.
    await prisma.candidate.update({ where: { id: candidate.id }, data: { piiPurgedAt: new Date(), normalizedEmail: null, normalizedPhone: null } });
    expect((await storage.getObject(document.storageKey)).length).toBeGreaterThan(0); // object still present

    const recoveredCount = await recoverInterruptedPurges(storage);
    expect(recoveredCount).toBe(1);

    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedDoc.purgedAt).not.toBeNull();
    await expect(storage.getObject(document.storageKey)).rejects.toBeTruthy();
  });

  it("recovery is idempotent against an already-deleted storage object", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate, document } = await seedCandidateWithLink(project.id);
    await storage.deleteObject(document.storageKey); // pre-delete, simulating a prior partial run
    await prisma.candidate.update({ where: { id: candidate.id }, data: { piiPurgedAt: new Date() } });

    await expect(recoverInterruptedPurges(storage)).resolves.toBe(1); // no throw on already-gone object

    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedDoc.purgedAt).not.toBeNull();
  });

  it("runScheduledPurgeScan recovers interrupted purges and purges newly-eligible candidates in one pass", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate: eligibleCandidate } = await seedCandidateWithLink(project.id);
    const { candidate: interruptedCandidate, document: interruptedDoc } = await seedCandidateWithLink(project.id);
    await prisma.candidate.update({ where: { id: interruptedCandidate.id }, data: { piiPurgedAt: new Date() } });

    const { recovered, purged } = await runScheduledPurgeScan({ storage });
    expect(recovered).toBe(1);
    expect(purged).toBe(1);

    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: eligibleCandidate.id } })).piiPurgedAt).not.toBeNull();
    expect((await prisma.candidateDocument.findUniqueOrThrow({ where: { id: interruptedDoc.id } })).purgedAt).not.toBeNull();
  });

  it("findEligibleCandidateIds returns only currently-eligible candidates", async () => {
    const { project: archived } = await seedProject("ARCHIVED");
    const { project: active } = await seedProject("ACTIVE");
    const { candidate: eligible } = await seedCandidateWithLink(archived.id);
    const { candidate: notEligible } = await seedCandidateWithLink(active.id);

    const ids = await findEligibleCandidateIds();
    expect(ids).toContain(eligible.id);
    expect(ids).not.toContain(notEligible.id);
  });

  // ---- Phase 8C fix: per-document failure isolation + audit completeness ----

  it("one document's storage failure does not prevent the other document from being purged, and exactly one PARTIAL audit record is written", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate, document: doc1 } = await seedCandidateWithLink(project.id);
    const key2 = `test/${candidate.id}-second.pdf`;
    await storage.putObject({ key: key2, body: Buffer.from("dummy pdf 2"), contentType: "application/pdf" });
    const doc2 = await prisma.candidateDocument.create({
      data: { candidateId: candidate.id, projectId: project.id, fileType: "pdf", storageKey: key2, originalFilename: "resume2.pdf", uploadedBy: project.createdBy, status: "COMPLETED" },
    });

    const flakyStorage = new FlakyObjectStorage(storage, new Set([doc1.storageKey]));
    const result = await executeCandidatePurge(candidate.id, "MANUAL", project.createdBy, { storage: flakyStorage });
    expect(result.status).toBe("PURGED");

    // The failing document is untouched; the other one still succeeded.
    const updatedDoc1 = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: doc1.id } });
    const updatedDoc2 = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: doc2.id } });
    expect(updatedDoc1.purgedAt).toBeNull();
    expect(updatedDoc2.purgedAt).not.toBeNull();

    // Candidate PII is still anonymized regardless of the storage failure.
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).piiPurgedAt).not.toBeNull();

    // Exactly one audit record, reflecting the partial outcome.
    const entries = await prisma.auditLog.findMany({ where: { entityType: "Candidate", entityId: candidate.id, action: "CANDIDATE_PII_PURGED" } });
    expect(entries).toHaveLength(1);
    expect(entries[0].afterJson).toMatchObject({ result: "PARTIAL", failedDocumentIds: [doc1.id] });

    // Recovery later completes the failed document without a second audit record.
    await recoverInterruptedPurges(storage); // real storage this time — no longer flaky
    expect((await prisma.candidateDocument.findUniqueOrThrow({ where: { id: doc1.id } })).purgedAt).not.toBeNull();
    const entriesAfterRecovery = await prisma.auditLog.findMany({ where: { entityType: "Candidate", entityId: candidate.id, action: "CANDIDATE_PII_PURGED" } });
    expect(entriesAfterRecovery).toHaveLength(1); // still exactly one — recovery never creates a duplicate
  });

  it("every document failing still anonymizes the Candidate and writes exactly one FAILED audit record", async () => {
    const { project } = await seedProject("ARCHIVED");
    const { candidate, document } = await seedCandidateWithLink(project.id);
    const flakyStorage = new FlakyObjectStorage(storage, new Set([document.storageKey]));

    const result = await executeCandidatePurge(candidate.id, "MANUAL", project.createdBy, { storage: flakyStorage });
    expect(result.status).toBe("PURGED");
    expect((await prisma.candidate.findUniqueOrThrow({ where: { id: candidate.id } })).piiPurgedAt).not.toBeNull();

    const entries = await prisma.auditLog.findMany({ where: { entityType: "Candidate", entityId: candidate.id, action: "CANDIDATE_PII_PURGED" } });
    expect(entries).toHaveLength(1);
    expect(entries[0].afterJson).toMatchObject({ result: "FAILED", failedDocumentIds: [document.id] });
  });
});

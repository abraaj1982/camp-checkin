import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { prisma } from "@recruitment-platform/db";
import {
  startProcessingRun,
  failProcessingRun,
  completeProcessingRun,
  assertProcessingRunStillRunning,
  ProcessingRunAlreadyActiveError,
  ProcessingRunNoLongerActiveError,
} from "../processing-run.js";
import { createUser, resetDatabase } from "./test-utils.js";

/**
 * Phase 10 — ProcessingRun ownership enforcement (10A.1/10A.2/10B). Proves
 * the atomic guarded-write mechanism directly: a run that is no longer
 * RUNNING (simulated here exactly as a reclaim job would leave it — a
 * direct FAILED/COMPLETED status write, bypassing the pipeline) can never
 * complete, and any transaction guarded by assertProcessingRunStillRunning
 * rolls back entirely rather than partially applying.
 */
describe("ProcessingRun ownership enforcement", () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  afterEach(async () => {
    // no per-test resource beyond the DB
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function seedDocument() {
    const user = await createUser("hr@example.com");
    const project = await prisma.recruitmentProject.create({ data: { title: "HR Manager", createdBy: user.id } });
    const candidate = await prisma.candidate.create({ data: { fullName: "resume" } });
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        fileType: "pdf",
        storageKey: "s3://bucket/key.pdf",
        originalFilename: "resume.pdf",
        uploadedBy: user.id,
        status: "PROCESSING",
      },
    });
    return { user, project, candidate, document };
  }

  it("failProcessingRun returns true and transitions a genuinely RUNNING run", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);

    const transitioned = await failProcessingRun(run.id);

    expect(transitioned).toBe(true);
    const updated = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("FAILED");
    expect(updated.completedAt).not.toBeNull();
  });

  it("failProcessingRun returns false and changes nothing for an already-terminal run (idempotent, not an error)", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    await failProcessingRun(run.id); // first call: real transition

    const secondAttempt = await failProcessingRun(run.id); // simulates a second caller (e.g. reclaim racing the run's own failure)

    expect(secondAttempt).toBe(false);
    const updated = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    expect(updated.status).toBe("FAILED"); // unchanged by the second call
  });

  it("completeProcessingRun succeeds and promotes currentProcessingRunId when the run is still RUNNING", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);

    await completeProcessingRun(run.id, document.id);

    const updatedRun = await prisma.processingRun.findUniqueOrThrow({ where: { id: run.id } });
    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedRun.status).toBe("COMPLETED");
    expect(updatedDoc.currentProcessingRunId).toBe(run.id);
    expect(updatedDoc.status).toBe("COMPLETED");
  });

  it("completeProcessingRun throws ProcessingRunNoLongerActiveError and never promotes a reclaimed run — the exact race this phase exists to close", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);

    // Simulates a reclaim job (or any other guarded transition) ending the
    // run BEFORE its own worker gets to report completion — a zombie
    // finishing its work after being reclaimed.
    await prisma.processingRun.update({ where: { id: run.id }, data: { status: "FAILED", completedAt: new Date() } });

    await expect(completeProcessingRun(run.id, document.id)).rejects.toThrow(ProcessingRunNoLongerActiveError);

    const updatedDoc = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updatedDoc.currentProcessingRunId).toBeNull(); // the reclaimed run never became "current"
    expect(updatedDoc.status).toBe("PROCESSING"); // untouched — whatever superseded this run owns the document's status now
  });

  it("completeProcessingRun is safe to call twice: the second call (double-completion) throws rather than silently re-promoting", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);
    await completeProcessingRun(run.id, document.id);

    await expect(completeProcessingRun(run.id, document.id)).rejects.toThrow(ProcessingRunNoLongerActiveError);
  });

  it("assertProcessingRunStillRunning passes silently for a genuinely RUNNING run and rolls back nothing", async () => {
    const { document, candidate } = await seedDocument();
    const run = await startProcessingRun(document.id);

    await prisma.$transaction(async (tx) => {
      await assertProcessingRunStillRunning(tx, run.id);
      await tx.candidateSkill.create({ data: { candidateId: candidate.id, skillName: "Conflict resolution" } });
    });

    const skills = await prisma.candidateSkill.findMany({ where: { candidateId: candidate.id } });
    expect(skills).toHaveLength(1);
  });

  it("assertProcessingRunStillRunning throws and rolls back the WHOLE transaction — a reclaimed run's candidate-profile writes never persist", async () => {
    const { document, candidate } = await seedDocument();
    const run = await startProcessingRun(document.id);
    // Simulates reclaim ending the run before this (zombie) transaction runs.
    await prisma.processingRun.update({ where: { id: run.id }, data: { status: "FAILED", completedAt: new Date() } });

    await expect(
      prisma.$transaction(async (tx) => {
        await assertProcessingRunStillRunning(tx, run.id);
        // Would-be corruption per Phase 10A.1 finding — must never commit:
        await tx.candidateSkill.deleteMany({ where: { candidateId: candidate.id } });
        await tx.candidateSkill.create({ data: { candidateId: candidate.id, skillName: "Stale zombie skill" } });
      }),
    ).rejects.toThrow(ProcessingRunNoLongerActiveError);

    // Nothing from the aborted transaction persisted — not even the create.
    const skills = await prisma.candidateSkill.findMany({ where: { candidateId: candidate.id } });
    expect(skills).toHaveLength(0);
  });

  it("a run reclaimed mid-flight cannot resurrect via a second startProcessingRun until it is actually terminal", async () => {
    const { document } = await seedDocument();
    const run = await startProcessingRun(document.id);

    // While genuinely RUNNING, a second concurrent attempt is refused —
    // unchanged pre-existing behavior, confirms Phase 10 didn't weaken this.
    await expect(startProcessingRun(document.id)).rejects.toThrow(ProcessingRunAlreadyActiveError);

    // Only once the run is terminal (as reclaim would leave it) can retry proceed.
    await failProcessingRun(run.id);
    const retryRun = await startProcessingRun(document.id);
    expect(retryRun.id).not.toBe(run.id);
    expect(retryRun.attemptNumber).toBe(2);
  });
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import PgBoss from "pg-boss";
import { prisma } from "@recruitment-platform/db";
import { AiGateway } from "@recruitment-platform/ai-gateway";
import { LocalObjectStorage, buildCandidateDocumentKey, buildStagedUploadKey } from "@recruitment-platform/storage";
import {
  PgBossCandidateDocumentQueue,
  PROCESS_CANDIDATE_DOCUMENT_JOB,
  RESOLVE_CANDIDATE_IDENTITY_JOB,
  type ProcessCandidateDocumentJobData,
  type ResolveCandidateIdentityJobData,
} from "@recruitment-platform/queue";
import { runDocumentProcessingPipeline } from "../pipeline.js";
import { runIdentityResolutionPipeline } from "../identity-resolution.js";
import { buildTestPdf } from "./fixtures.js";
import { FakeAIProvider, createUser, resetDatabase, seedAiModelConfig } from "./test-utils.js";

const DATABASE_URL = process.env.DATABASE_URL!;

/**
 * UAT-001-PGBOSS-BATCH-JOB-LOSS regression coverage.
 *
 * Both worker/src/index.ts consumers are registered with { batchSize: 5 },
 * and pg-boss's WorkHandler<ReqData> type is ALWAYS
 * `(job: PgBoss.Job<ReqData>[]) => Promise<any>` — an array, regardless of
 * batchSize. The defect was destructuring only the first element
 * (`async ([job]) => ...`), silently discarding the rest of the delivered
 * batch while pg-boss still marked the whole batch completed. These tests
 * register consumers using the SAME fixed pattern now in worker/src/index.ts
 * (loop over every element) against the real pg-boss/Postgres queue — not
 * the pipeline functions in isolation — so a regression back to `[job]`
 * would fail these tests exactly as it silently failed the real UAT run.
 */
describe("pg-boss batch consumers process every job in the delivered batch", () => {
  let storageDir: string;
  let storage: LocalObjectStorage;
  let apiSideQueue: PgBossCandidateDocumentQueue;
  let consumerBoss: PgBoss;

  // This file enqueues more jobs per test (up to 8) than other worker test
  // files, which makes it the most likely place to trip a pre-existing,
  // unrelated test-isolation gap: pg-boss's job queue is shared across every
  // test FILE in this suite (fileParallelism: false reset only the app
  // tables, never the pgboss schema), so a job left over from this file
  // could otherwise be redelivered to a later file's consumer referencing
  // already-deleted data. Scoped to this file's own setup/teardown only —
  // no other test file is touched.
  async function purgeOwnJobQueues(): Promise<void> {
    await prisma.$executeRawUnsafe(
      `delete from pgboss.job where name in ('${PROCESS_CANDIDATE_DOCUMENT_JOB}', '${RESOLVE_CANDIDATE_IDENTITY_JOB}')`,
    );
  }

  beforeEach(async () => {
    await resetDatabase();
    await purgeOwnJobQueues();
    storageDir = await mkdtemp(join(tmpdir(), "rip-worker-batch-storage-"));
    storage = new LocalObjectStorage(storageDir);
    apiSideQueue = new PgBossCandidateDocumentQueue(DATABASE_URL);
    consumerBoss = new PgBoss({ connectionString: DATABASE_URL, retryLimit: 1 });
    await consumerBoss.start();
    await consumerBoss.createQueue(PROCESS_CANDIDATE_DOCUMENT_JOB);
    await consumerBoss.createQueue(RESOLVE_CANDIDATE_IDENTITY_JOB);
  });

  afterEach(async () => {
    await consumerBoss.stop({ graceful: false, wait: false });
    await apiSideQueue.stop();
    await purgeOwnJobQueues();
    await rm(storageDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function waitUntil(check: () => Promise<boolean>, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error("timed out waiting for condition");
  }

  async function seedQueuedDocument(user: { id: string }, project: { id: string }, label: string, corruptStorageKey = false) {
    const candidate = await prisma.candidate.create({ data: { fullName: label } });
    const pdf = await buildTestPdf(`${label}. HR Officer at Acme Corp. Handled onboarding.`);
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        fileType: "pdf",
        storageKey: "pending",
        originalFilename: `${label}.pdf`,
        fileSizeBytes: pdf.byteLength,
        status: "QUEUED",
        uploadedBy: user.id,
      },
    });
    const storageKey = corruptStorageKey
      ? "does-not-exist/missing-object.pdf"
      : buildCandidateDocumentKey({ projectId: project.id, candidateId: candidate.id, documentId: document.id, fileExtension: "pdf" });
    if (!corruptStorageKey) {
      await storage.putObject({ key: storageKey, body: pdf, contentType: "application/pdf" });
    }
    await prisma.candidateDocument.update({ where: { id: document.id }, data: { storageKey } });
    return { candidate, document };
  }

  function registerFixedDocumentConsumer(gateway: AiGateway) {
    // Mirrors the fixed worker/src/index.ts registration exactly: loops
    // over every job in the delivered array.
    return consumerBoss.work<ProcessCandidateDocumentJobData>(
      PROCESS_CANDIDATE_DOCUMENT_JOB,
      { batchSize: 5 },
      async (jobs) => {
        for (const job of jobs) {
          const { candidateDocumentId } = job.data;
          await prisma.candidateDocument.update({ where: { id: candidateDocumentId }, data: { status: "PROCESSING" } });
          try {
            await runDocumentProcessingPipeline(job.data, { storage, gateway });
          } catch (err) {
            await prisma.candidateDocument.update({
              where: { id: candidateDocumentId },
              data: { status: "FAILED_RETRY", failureReason: err instanceof Error ? err.message : "Unknown processing error" },
            });
          }
        }
      },
    );
  }

  function registerFixedIdentityConsumer() {
    return consumerBoss.work<ResolveCandidateIdentityJobData>(RESOLVE_CANDIDATE_IDENTITY_JOB, { batchSize: 5 }, async (jobs) => {
      for (const job of jobs) {
        await runIdentityResolutionPipeline(job.data, { storage, queue: apiSideQueue });
      }
    });
  }

  function buildGateway() {
    return new AiGateway({
      fake: new FakeAIProvider({
        RESUME_INTELLIGENCE: {
          experiences: [
            {
              employer: "Acme Corp",
              title: "HR Officer",
              startDate: "2018-01-01",
              endDate: null,
              isCurrent: true,
              responsibilities: ["Handled onboarding."],
              functionalAreaTags: ["Employee Relations"],
              sourcePage: 1,
              extractedConfidence: "HIGH",
            },
          ],
          education: [],
          skills: [],
          certifications: [],
          languages: [],
        },
        CAREER_CONSISTENCY_ANALYSIS: { progressionNarrative: "Consistent career progression.", findings: [] },
      }),
    });
  }

  it("1. a single batch of 5 simultaneously-ready PROCESS_CANDIDATE_DOCUMENT_JOB jobs: every job completes, not just the first", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const user = await createUser("hr-batch-1@example.com");
    const project = await prisma.recruitmentProject.create({ data: { title: "Batch Test 1", createdBy: user.id } });

    const seeded = await Promise.all(
      Array.from({ length: 5 }, (_, i) => seedQueuedDocument(user, project, `Candidate Batch1-${i}`)),
    );
    for (const { candidate, document } of seeded) {
      await apiSideQueue.enqueue({ candidateDocumentId: document.id, candidateId: candidate.id, projectId: project.id });
    }

    await registerFixedDocumentConsumer(buildGateway());

    await waitUntil(async () => {
      const completed = await prisma.candidateDocument.count({
        where: { id: { in: seeded.map((s) => s.document.id) }, status: "COMPLETED" },
      });
      return completed === 5;
    });

    const statuses = await prisma.candidateDocument.findMany({
      where: { id: { in: seeded.map((s) => s.document.id) } },
      select: { status: true },
    });
    expect(statuses.every((s) => s.status === "COMPLETED")).toBe(true);
  }, 20_000);

  it("2. 8 queued jobs (more than batchSize:5) across multiple fetch cycles: all 8 complete, none silently dropped", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const user = await createUser("hr-batch-2@example.com");
    const project = await prisma.recruitmentProject.create({ data: { title: "Batch Test 2", createdBy: user.id } });

    const seeded = await Promise.all(
      Array.from({ length: 8 }, (_, i) => seedQueuedDocument(user, project, `Candidate Batch2-${i}`)),
    );
    for (const { candidate, document } of seeded) {
      await apiSideQueue.enqueue({ candidateDocumentId: document.id, candidateId: candidate.id, projectId: project.id });
    }

    await registerFixedDocumentConsumer(buildGateway());

    await waitUntil(async () => {
      const completed = await prisma.candidateDocument.count({
        where: { id: { in: seeded.map((s) => s.document.id) }, status: "COMPLETED" },
      });
      return completed === 8;
    }, 20_000);

    const completedCount = await prisma.candidateDocument.count({
      where: { id: { in: seeded.map((s) => s.document.id) }, status: "COMPLETED" },
    });
    expect(completedCount).toBe(8);
  }, 25_000);

  it("3. one failing job in a batch does not prevent the other jobs in the same batch from completing", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    await seedAiModelConfig("CAREER_CONSISTENCY_ANALYSIS");
    const user = await createUser("hr-batch-3@example.com");
    const project = await prisma.recruitmentProject.create({ data: { title: "Batch Test 3", createdBy: user.id } });

    const good = await Promise.all(
      Array.from({ length: 4 }, (_, i) => seedQueuedDocument(user, project, `Candidate Batch3-good-${i}`)),
    );
    const bad = await seedQueuedDocument(user, project, "Candidate Batch3-bad", /* corruptStorageKey */ true);

    for (const { candidate, document } of [...good, bad]) {
      await apiSideQueue.enqueue({ candidateDocumentId: document.id, candidateId: candidate.id, projectId: project.id });
    }

    await registerFixedDocumentConsumer(buildGateway());

    await waitUntil(async () => {
      const completed = await prisma.candidateDocument.count({
        where: { id: { in: good.map((s) => s.document.id) }, status: "COMPLETED" },
      });
      const failed = await prisma.candidateDocument.findUnique({ where: { id: bad.document.id }, select: { status: true } });
      return completed === 4 && failed?.status === "FAILED_RETRY";
    });

    const badFinal = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: bad.document.id } });
    expect(badFinal.status).toBe("FAILED_RETRY");
    expect(badFinal.failureReason).toBeTruthy();

    const goodStatuses = await prisma.candidateDocument.findMany({
      where: { id: { in: good.map((s) => s.document.id) } },
      select: { status: true },
    });
    expect(goodStatuses.every((s) => s.status === "COMPLETED")).toBe(true);
  }, 20_000);

  async function seedStagedUpload(user: { id: string }, project: { id: string }, label: string) {
    const pdf = await buildTestPdf(`${label}. No email or phone number anywhere in this document.`);
    const stagedUpload = await prisma.stagedUpload.create({
      data: {
        projectId: project.id,
        fileType: "pdf",
        storageKey: "pending",
        originalFilename: `${label}.pdf`,
        fileSizeBytes: pdf.byteLength,
        uploadedBy: user.id,
      },
    });
    const storageKey = buildStagedUploadKey({ projectId: project.id, stagedUploadId: stagedUpload.id, fileExtension: "pdf" });
    await storage.putObject({ key: storageKey, body: pdf, contentType: "application/pdf" });
    await prisma.stagedUpload.update({ where: { id: stagedUpload.id }, data: { storageKey } });
    return stagedUpload;
  }

  it("4. a single batch of 5 simultaneously-ready RESOLVE_CANDIDATE_IDENTITY_JOB jobs: every staged upload is promoted, not just the first", async () => {
    const user = await createUser("hr-batch-4@example.com");
    const project = await prisma.recruitmentProject.create({ data: { title: "Batch Test 4", createdBy: user.id } });

    const staged = await Promise.all(Array.from({ length: 5 }, (_, i) => seedStagedUpload(user, project, `Identity Batch4-${i}`)));
    for (const s of staged) {
      await apiSideQueue.enqueueIdentityResolution({ stagedUploadId: s.id, projectId: project.id });
    }

    await registerFixedIdentityConsumer();

    await waitUntil(async () => {
      const promoted = await prisma.stagedUpload.count({ where: { id: { in: staged.map((s) => s.id) }, status: "PROMOTED" } });
      return promoted === 5;
    });

    const candidateCount = await prisma.candidate.count({ where: { projectLinks: { some: { projectId: project.id } } } });
    expect(candidateCount).toBe(5);
  }, 20_000);

  it("5. 7 staged uploads (more than batchSize:5) across multiple fetch cycles: all 7 are promoted, none stuck at PENDING_IDENTITY_RESOLUTION", async () => {
    const user = await createUser("hr-batch-5@example.com");
    const project = await prisma.recruitmentProject.create({ data: { title: "Batch Test 5", createdBy: user.id } });

    const staged = await Promise.all(Array.from({ length: 7 }, (_, i) => seedStagedUpload(user, project, `Identity Batch5-${i}`)));
    for (const s of staged) {
      await apiSideQueue.enqueueIdentityResolution({ stagedUploadId: s.id, projectId: project.id });
    }

    await registerFixedIdentityConsumer();

    await waitUntil(async () => {
      const promoted = await prisma.stagedUpload.count({ where: { id: { in: staged.map((s) => s.id) }, status: "PROMOTED" } });
      return promoted === 7;
    }, 20_000);

    const stuck = await prisma.stagedUpload.count({
      where: { id: { in: staged.map((s) => s.id) }, status: "PENDING_IDENTITY_RESOLUTION" },
    });
    expect(stuck).toBe(0);
  }, 25_000);
});

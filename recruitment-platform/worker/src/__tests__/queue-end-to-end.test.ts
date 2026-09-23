import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import PgBoss from "pg-boss";
import { prisma } from "@recruitment-platform/db";
import { AiGateway } from "@recruitment-platform/ai-gateway";
import { LocalObjectStorage, buildCandidateDocumentKey } from "@recruitment-platform/storage";
import {
  PgBossCandidateDocumentQueue,
  PROCESS_CANDIDATE_DOCUMENT_JOB,
  type ProcessCandidateDocumentJobData,
} from "@recruitment-platform/queue";
import { runDocumentProcessingPipeline } from "../pipeline.js";
import { buildTestPdf } from "./fixtures.js";
import { FakeAIProvider, createUser, resetDatabase, seedAiModelConfig } from "./test-utils.js";

const DATABASE_URL = process.env.DATABASE_URL!;

/**
 * Proves the real pg-boss plumbing (not just the pipeline function called
 * directly, as in pipeline.test.ts): the API's enqueue path
 * (PgBossCandidateDocumentQueue) and a worker-style consumer both talk to
 * the same Postgres-backed queue, matching how apps/api and worker actually
 * communicate in production (architecture doc Decision 8: pg-boss on
 * Postgres, no Redis).
 */
describe("pg-boss end-to-end: enqueue -> consume -> process", () => {
  let storageDir: string;
  let storage: LocalObjectStorage;
  let apiSideQueue: PgBossCandidateDocumentQueue;
  let consumerBoss: PgBoss;

  beforeEach(async () => {
    await resetDatabase();
    storageDir = await mkdtemp(join(tmpdir(), "rip-worker-e2e-storage-"));
    storage = new LocalObjectStorage(storageDir);
    apiSideQueue = new PgBossCandidateDocumentQueue(DATABASE_URL);
    consumerBoss = new PgBoss({ connectionString: DATABASE_URL, retryLimit: 1 });
    await consumerBoss.start();
    await consumerBoss.createQueue(PROCESS_CANDIDATE_DOCUMENT_JOB);
  });

  afterEach(async () => {
    await consumerBoss.stop({ graceful: false, wait: false });
    await apiSideQueue.stop();
    await rm(storageDir, { recursive: true, force: true });
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("processes a job enqueued via the API-side queue with a real worker consumer", async () => {
    await seedAiModelConfig("RESUME_INTELLIGENCE");
    const user = await createUser("hr@example.com");
    const project = await prisma.recruitmentProject.create({ data: { title: "HR Manager", createdBy: user.id } });
    const candidate = await prisma.candidate.create({ data: { fullName: "resume" } });
    const pdf = await buildTestPdf("Jane Doe. HR Manager at Acme Corp. Led grievance handling and investigations.");
    const document = await prisma.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: project.id,
        fileType: "pdf",
        storageKey: "pending",
        originalFilename: "resume.pdf",
        fileSizeBytes: pdf.byteLength,
        status: "QUEUED",
        uploadedBy: user.id,
      },
    });
    const storageKey = buildCandidateDocumentKey({
      projectId: project.id,
      candidateId: candidate.id,
      documentId: document.id,
      fileExtension: "pdf",
    });
    await storage.putObject({ key: storageKey, body: pdf, contentType: "application/pdf" });
    await prisma.candidateDocument.update({ where: { id: document.id }, data: { storageKey } });

    // This is the API's exact enqueue path, not a test shortcut.
    await apiSideQueue.enqueue({ candidateDocumentId: document.id, candidateId: candidate.id, projectId: project.id });

    const gateway = new AiGateway({
      fake: new FakeAIProvider({
        RESUME_INTELLIGENCE: {
          experiences: [
            {
              employer: "Acme Corp",
              title: "HR Manager",
              startDate: "2018-01-01",
              endDate: null,
              isCurrent: true,
              responsibilities: ["Led grievance handling and investigations."],
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
      }),
    });

    const processed = new Promise<void>((resolve, reject) => {
      consumerBoss
        .work<ProcessCandidateDocumentJobData>(PROCESS_CANDIDATE_DOCUMENT_JOB, { batchSize: 1 }, async ([job]) => {
          try {
            await prisma.candidateDocument.update({ where: { id: job.data.candidateDocumentId }, data: { status: "PROCESSING" } });
            await runDocumentProcessingPipeline(job.data, { storage, gateway });
            resolve();
          } catch (err) {
            reject(err);
          }
        })
        .catch(reject);
    });

    await Promise.race([
      processed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("timed out waiting for job")), 15_000)),
    ]);

    const updated = await prisma.candidateDocument.findUniqueOrThrow({ where: { id: document.id } });
    expect(updated.status).toBe("COMPLETED");

    const experiences = await prisma.candidateExperience.findMany({ where: { candidateId: candidate.id } });
    expect(experiences).toHaveLength(1);
    expect(experiences[0].employer).toBe("Acme Corp");
  });
});

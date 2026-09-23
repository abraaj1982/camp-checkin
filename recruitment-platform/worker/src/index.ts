import { prisma } from "@recruitment-platform/db";
import { AiGateway, ClaudeProvider, type AIProvider } from "@recruitment-platform/ai-gateway";
import { S3ObjectStorage, LocalObjectStorage, type ObjectStorage } from "@recruitment-platform/storage";
import {
  PROCESS_CANDIDATE_DOCUMENT_JOB,
  type ProcessCandidateDocumentJobData,
} from "@recruitment-platform/queue";
import { runDocumentProcessingPipeline } from "./pipeline.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");

function buildStorage(): ObjectStorage {
  if (process.env.OBJECT_STORAGE_DRIVER === "local") {
    return new LocalObjectStorage(process.env.OBJECT_STORAGE_LOCAL_DIR ?? "./.local-object-storage");
  }
  const bucket = process.env.OBJECT_STORAGE_BUCKET;
  const accessKeyId = process.env.OBJECT_STORAGE_ACCESS_KEY_ID;
  const secretAccessKey = process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing OBJECT_STORAGE_BUCKET/OBJECT_STORAGE_ACCESS_KEY_ID/OBJECT_STORAGE_SECRET_ACCESS_KEY " +
        "(or set OBJECT_STORAGE_DRIVER=local for local dev without MinIO).",
    );
  }
  return new S3ObjectStorage({
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    bucket,
    accessKeyId,
    secretAccessKey,
  });
}

async function main() {
  const storage = buildStorage();

  const providers: Record<string, AIProvider> = {};
  if (process.env.ANTHROPIC_API_KEY) {
    providers.claude = new ClaudeProvider(process.env.ANTHROPIC_API_KEY);
  }
  const gateway = new AiGateway(providers);

  await runWorker(storage, gateway);
}

async function runWorker(storage: ObjectStorage, gateway: AiGateway) {
  // @recruitment-platform/queue's PgBossCandidateDocumentQueue only exposes
  // enqueue() (the API's view of the queue); the worker needs the
  // underlying PgBoss instance to register a consumer, so it manages its
  // own connection here against the same pg-boss-managed tables.
  const PgBoss = (await import("pg-boss")).default;
  const boss = new PgBoss({ connectionString: databaseUrl!, retryLimit: 3, retryBackoff: true });
  await boss.start();
  await boss.createQueue(PROCESS_CANDIDATE_DOCUMENT_JOB);

  await boss.work<ProcessCandidateDocumentJobData>(
    PROCESS_CANDIDATE_DOCUMENT_JOB,
    { batchSize: 5 }, // bounded concurrency (architecture doc: Batch Processing Architecture)
    async ([job]) => {
      const { candidateDocumentId } = job.data;

      await prisma.candidateDocument.update({
        where: { id: candidateDocumentId },
        data: { status: "PROCESSING" },
      });

      try {
        // Terminal states (COMPLETED, FAILED_NEEDS_OCR) are set inside the
        // pipeline itself; this only handles the retryable-failure case.
        await runDocumentProcessingPipeline(job.data, { storage, gateway });
      } catch (err) {
        // One candidate's failure never blocks or fails the batch (Section
        // 41) — recorded on its own document row; the worker keeps consuming.
        await prisma.candidateDocument.update({
          where: { id: candidateDocumentId },
          data: {
            status: "FAILED_RETRY",
            failureReason: err instanceof Error ? err.message : "Unknown processing error",
          },
        });
      }
    },
  );

  // eslint-disable-next-line no-console
  console.log("Worker listening for candidate document jobs");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

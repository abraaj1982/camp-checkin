import { prisma, recordAudit } from "@recruitment-platform/db";
import { AiGateway, ClaudeProvider, type AIProvider } from "@recruitment-platform/ai-gateway";
import { S3ObjectStorage, LocalObjectStorage, type ObjectStorage } from "@recruitment-platform/storage";
import {
  PROCESS_CANDIDATE_DOCUMENT_JOB,
  RESOLVE_CANDIDATE_IDENTITY_JOB,
  type ProcessCandidateDocumentJobData,
  type ResolveCandidateIdentityJobData,
  PgBossCandidateDocumentQueue,
} from "@recruitment-platform/queue";
import { runDocumentProcessingPipeline } from "./pipeline.js";
import { runIdentityResolutionPipeline } from "./identity-resolution.js";
import { runScheduledPurgeScan } from "./candidate-purge.js";
import { ProcessingRunNoLongerActiveError } from "./processing-run.js";

// Phase 8 — PII Retention/Purge. Not an application-triggered job like the
// two above — pg-boss.schedule() runs it on a cron, the first time-based
// (rather than event-triggered) job in this system.
const SCHEDULED_PURGE_SCAN_JOB = "scheduled-purge-scan";

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
  // enqueue()/enqueueIdentityResolution() (the API's view of the queue);
  // the worker needs the underlying PgBoss instance to register consumers,
  // so it manages its own connection here against the same
  // pg-boss-managed tables. The same PgBossCandidateDocumentQueue is also
  // constructed below so the identity-resolution job can re-use the
  // existing enqueue() abstraction (never a raw boss.send call) when a
  // no-match upload promotes straight to normal processing.
  const PgBoss = (await import("pg-boss")).default;
  const boss = new PgBoss({ connectionString: databaseUrl!, retryLimit: 3, retryBackoff: true });
  await boss.start();
  await boss.createQueue(PROCESS_CANDIDATE_DOCUMENT_JOB);
  await boss.createQueue(RESOLVE_CANDIDATE_IDENTITY_JOB);
  await boss.createQueue(SCHEDULED_PURGE_SCAN_JOB);

  const queue = new PgBossCandidateDocumentQueue(databaseUrl!);

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
        // Phase 10 — a stale/reclaimed run must become harmless: it must
        // NOT flip the document to FAILED_RETRY (that would be exactly the
        // "late-arriving worker changes current state" outcome the whole
        // ownership mechanism exists to prevent — whatever superseded this
        // run is already responsible for the document's status). Recorded
        // for operational visibility only, then treated as a clean no-op —
        // never retried, never re-queued from here.
        if (err instanceof ProcessingRunNoLongerActiveError) {
          await recordAudit({
            actorId: null,
            action: "PROCESSING_RUN_STALE_WRITE_ABORTED",
            entityType: "ProcessingRun",
            entityId: err.processingRunId,
            after: { candidateDocumentId },
          });
          return;
        }
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

  // Phase 7 — Candidate Deduplication. Failure handling lives entirely
  // inside runIdentityResolutionPipeline (StagedUpload -> FAILED on any
  // thrown error) so this handler never needs its own catch — mirrors how
  // the pipeline above keeps its own terminal-state writes internal.
  await boss.work<ResolveCandidateIdentityJobData>(
    RESOLVE_CANDIDATE_IDENTITY_JOB,
    { batchSize: 5 },
    async ([job]) => {
      await runIdentityResolutionPipeline(job.data, { storage, queue });
    },
  );

  // Phase 8 — PII Retention/Purge. Daily at 02:00 Asia/Muscat. Manual
  // purge (apps/api/src/modules/candidate-purge/routes.ts) and this
  // scheduled scan both call the exact same runScheduledPurgeScan/
  // executeCandidatePurge implementation in candidate-purge.ts — never two
  // purge implementations.
  await boss.schedule(SCHEDULED_PURGE_SCAN_JOB, "0 2 * * *", {}, { tz: "Asia/Muscat" });
  await boss.work(SCHEDULED_PURGE_SCAN_JOB, { batchSize: 1 }, async () => {
    await runScheduledPurgeScan({ storage });
  });

  // eslint-disable-next-line no-console
  console.log("Worker listening for candidate document jobs");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

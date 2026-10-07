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
import { ProcessingRunNoLongerActiveError, ProcessingRunAlreadyActiveError, runReclaimScan } from "./processing-run.js";

// Phase 8 — PII Retention/Purge. Not an application-triggered job like the
// two above — pg-boss.schedule() runs it on a cron, the first time-based
// (rather than event-triggered) job in this system.
const SCHEDULED_PURGE_SCAN_JOB = "scheduled-purge-scan";
// Phase 10D — ProcessingRun stale reclaim. Runs every minute — more
// frequent than STALE_THRESHOLD_MS (3 minutes) so detection latency stays
// close to that bound (worst case roughly threshold + this interval).
const RECLAIM_STALE_PROCESSING_RUNS_JOB = "reclaim-stale-processing-runs";

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
  await boss.createQueue(RECLAIM_STALE_PROCESSING_RUNS_JOB);

  const queue = new PgBossCandidateDocumentQueue(databaseUrl!);

  await boss.work<ProcessCandidateDocumentJobData>(
    PROCESS_CANDIDATE_DOCUMENT_JOB,
    { batchSize: 5 }, // bounded concurrency (architecture doc: Batch Processing Architecture)
    // pg-boss's WorkHandler always delivers the full fetched batch as an
    // array (up to batchSize), whatever batchSize is set to — every element
    // must be processed here, not just the first, or the remainder is
    // silently marked completed without ever running (UAT-001-PGBOSS-BATCH-JOB-LOSS).
    async (jobs) => {
      for (const job of jobs) {
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
          // Phase 10D — benign duplicate delivery (e.g. pg-boss's own
          // retryLimit/expiration dispatching a second attempt while the
          // first is still genuinely alive, per Phase 10C's finding — pg-boss
          // expiry is left unchanged this phase). No ProcessingRun was ever
          // created for this refused attempt, so there is nothing to clean
          // up: not a failure, not retried further, not re-enqueued, and not
          // worth a business AuditLog row — a lightweight log is sufficient.
          if (err instanceof ProcessingRunAlreadyActiveError) {
            // eslint-disable-next-line no-console
            console.warn("[worker] duplicate delivery: a ProcessingRun is already RUNNING for this document", {
              candidateDocumentId,
            });
            continue;
          }
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
            continue;
          }
          // One candidate's failure never blocks or fails the batch (Section
          // 41) — recorded on its own document row; the worker keeps consuming
          // the rest of this same batch via the loop, then the next batch.
          await prisma.candidateDocument.update({
            where: { id: candidateDocumentId },
            data: {
              status: "FAILED_RETRY",
              failureReason: err instanceof Error ? err.message : "Unknown processing error",
            },
          });
        }
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
    // See the PROCESS_CANDIDATE_DOCUMENT_JOB handler above: every element of
    // the delivered batch must be processed, not just the first
    // (UAT-001-PGBOSS-BATCH-JOB-LOSS).
    async (jobs) => {
      for (const job of jobs) {
        await runIdentityResolutionPipeline(job.data, { storage, queue });
      }
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

  // Phase 10D — stale ProcessingRun reclaim. Every minute (see the
  // constant's own comment above for why); no automatic requeue — reclaim
  // only transitions ProcessingRun -> FAILED and CandidateDocument ->
  // FAILED_RETRY, atomically; the existing manual retry route remains the
  // sole path back into processing.
  await boss.schedule(RECLAIM_STALE_PROCESSING_RUNS_JOB, "* * * * *", {}, {});
  await boss.work(RECLAIM_STALE_PROCESSING_RUNS_JOB, { batchSize: 1 }, async () => {
    await runReclaimScan();
  });

  // eslint-disable-next-line no-console
  console.log("Worker listening for candidate document jobs");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

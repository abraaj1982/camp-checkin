import { prisma } from "@recruitment-platform/db";
import { getQueue, PROCESS_CANDIDATE_DOCUMENT_JOB, type ProcessCandidateDocumentJobData } from "./queue.js";
import { runDocumentProcessingPipeline } from "./pipeline.js";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Missing required environment variable: DATABASE_URL");

async function main() {
  const queue = await getQueue(databaseUrl!);

  await queue.work<ProcessCandidateDocumentJobData>(
    PROCESS_CANDIDATE_DOCUMENT_JOB,
    { batchSize: 5 }, // bounded concurrency (architecture doc: Batch Processing Architecture)
    async ([job]) => {
      const { candidateDocumentId } = job.data;

      await prisma.candidateDocument.update({
        where: { id: candidateDocumentId },
        data: { status: "PROCESSING" },
      });

      try {
        await runDocumentProcessingPipeline(job.data);
        await prisma.candidateDocument.update({
          where: { id: candidateDocumentId },
          data: { status: "COMPLETED" },
        });
      } catch (err) {
        // One candidate's failure never blocks or fails the batch (Section
        // 41) — it is recorded on its own document row and the worker keeps
        // consuming the queue.
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

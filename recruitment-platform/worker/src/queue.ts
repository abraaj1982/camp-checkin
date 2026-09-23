import PgBoss from "pg-boss";

export const PROCESS_CANDIDATE_DOCUMENT_JOB = "process-candidate-document";

export interface ProcessCandidateDocumentJobData {
  candidateDocumentId: string;
  candidateId: string;
  projectId: string;
}

let boss: PgBoss | undefined;

/**
 * pg-boss on Postgres, per architecture doc Decision 8 — no Redis unless a
 * demonstrated need shows up. Each CV upload enqueues one job per candidate
 * document, so one candidate's failure never blocks the rest of the batch
 * (Section 41).
 */
export async function getQueue(connectionString: string): Promise<PgBoss> {
  if (boss) return boss;
  boss = new PgBoss({
    connectionString,
    retryLimit: 3,
    retryBackoff: true,
  });
  await boss.start();
  await boss.createQueue(PROCESS_CANDIDATE_DOCUMENT_JOB);
  return boss;
}

export async function enqueueCandidateDocumentProcessing(
  connectionString: string,
  data: ProcessCandidateDocumentJobData,
): Promise<void> {
  const queue = await getQueue(connectionString);
  await queue.send(PROCESS_CANDIDATE_DOCUMENT_JOB, data);
}

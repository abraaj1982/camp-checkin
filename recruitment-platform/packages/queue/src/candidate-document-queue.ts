import PgBoss from "pg-boss";

export const PROCESS_CANDIDATE_DOCUMENT_JOB = "process-candidate-document";

export interface ProcessCandidateDocumentJobData {
  candidateDocumentId: string;
  candidateId: string;
  projectId: string;
}

/**
 * The one queue interface both the API (enqueues on upload) and the worker
 * (consumes) depend on — same abstraction-over-a-vendor-library pattern as
 * AIProvider/ObjectStorage, so tests can swap in an in-memory fake instead
 * of standing up a consumer for every upload test (architecture doc
 * Decision 8: pg-boss on Postgres, no Redis unless demonstrated need).
 */
export interface CandidateDocumentQueue {
  enqueue(data: ProcessCandidateDocumentJobData): Promise<void>;
}

export class PgBossCandidateDocumentQueue implements CandidateDocumentQueue {
  private bossPromise?: Promise<PgBoss>;

  constructor(private readonly connectionString: string) {}

  private async getBoss(): Promise<PgBoss> {
    if (!this.bossPromise) {
      this.bossPromise = (async () => {
        const boss = new PgBoss({
          connectionString: this.connectionString,
          retryLimit: 3,
          retryBackoff: true,
        });
        await boss.start();
        await boss.createQueue(PROCESS_CANDIDATE_DOCUMENT_JOB);
        return boss;
      })();
    }
    return this.bossPromise;
  }

  async enqueue(data: ProcessCandidateDocumentJobData): Promise<void> {
    const boss = await this.getBoss();
    await boss.send(PROCESS_CANDIDATE_DOCUMENT_JOB, data);
  }

  async stop(): Promise<void> {
    if (this.bossPromise) {
      const boss = await this.bossPromise;
      await boss.stop();
    }
  }
}

/** In-memory fake for tests — captures enqueued jobs, never touches Postgres. */
export class FakeCandidateDocumentQueue implements CandidateDocumentQueue {
  readonly enqueued: ProcessCandidateDocumentJobData[] = [];

  async enqueue(data: ProcessCandidateDocumentJobData): Promise<void> {
    this.enqueued.push(data);
  }
}

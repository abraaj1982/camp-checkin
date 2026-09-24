import { prisma, type ProcessingRun } from "@recruitment-platform/db";

/**
 * ProcessingRun lifecycle (Phase 4A retry design, approved). One row per
 * execution of the whole per-document pipeline (parse -> Resume
 * Intelligence -> Requirement Evidence Analysis). Never deleted, never
 * updated once terminal (COMPLETED/FAILED) — a retry always creates a new
 * run rather than touching an old one, so Assessment/Evidence rows stay
 * exactly as written, forever, addressable through the run that produced
 * them.
 *
 * Concurrency invariant: a new ProcessingRun never silently invalidates an
 * existing RUNNING one. startProcessingRun() refuses (throws
 * ProcessingRunAlreadyActiveError) if a RUNNING run already exists for the
 * document, rather than marking it FAILED. See that function's docs for
 * the exact three ways a RUNNING run is allowed to become FAILED.
 */

/**
 * Thrown by startProcessingRun() when a ProcessingRun for this document is
 * already RUNNING. The caller (worker/src/pipeline.ts, via
 * worker/src/index.ts's job handler) treats this like any other thrown
 * pipeline error: the document is marked FAILED_RETRY and the job ends.
 * Nothing about the existing RUNNING run is touched — it is left exactly
 * as it was, for whichever of the three paths in this module's docs
 * eventually resolves it.
 */
export class ProcessingRunAlreadyActiveError extends Error {
  constructor(public readonly candidateDocumentId: string) {
    super(`A ProcessingRun is already RUNNING for CandidateDocument ${candidateDocumentId}`);
    this.name = "ProcessingRunAlreadyActiveError";
  }
}

/**
 * Starts a new run for this document — but refuses if one is already
 * RUNNING, rather than invalidating it.
 *
 * The invariant (Phase 4A, revised): a new ProcessingRun must never
 * silently mark an existing RUNNING run FAILED. If a RUNNING run already
 * exists for this candidateDocumentId, this function throws
 * ProcessingRunAlreadyActiveError and creates nothing — no new run, no
 * attempt-number claim, no write to the existing run.
 *
 * A RUNNING run becomes FAILED through exactly three paths, and no others:
 *   1. An actual pipeline failure calling failProcessingRun() on ITS OWN
 *      run id (worker/src/pipeline.ts's catch blocks) — the run reporting
 *      its own outcome, never a different run reporting it for it.
 *   2. An explicit retry/recovery operation that a human or operator
 *      triggers deliberately (not implemented by this module — the
 *      existing HR "retry a FAILED_RETRY document" route only starts a new
 *      run once the CandidateDocument itself is already off PROCESSING;
 *      it does not touch a RUNNING ProcessingRun row at all).
 *   3. A future, explicit stale-run cleanup mechanism (not built yet,
 *      deliberately) — e.g. an operator action or a heartbeat/timeout
 *      system, if one is designed and approved later. Until then, a
 *      ProcessingRun that gets stuck at RUNNING (worker crash, OOM, kill
 *      -9) stays RUNNING, and every subsequent attempt to process this
 *      same document refuses via this error, rather than guessing.
 *
 * This intentionally trades liveness for correctness: without a
 * heartbeat/timeout (explicitly deferred, per instruction) there is no
 * reliable way to tell "crashed 3 days ago" apart from "genuinely still
 * executing right now," so this function does not try — it never silently
 * decides a RUNNING run is stale. currentProcessingRunId is unaffected
 * either way: it is changed only by completeProcessingRun(), never here.
 *
 * Race-safety of the refusal itself: the RUNNING check and the
 * attempt-number claim both run inside one interactive transaction, and
 * the claim's `UPDATE ... increment ...` on CandidateDocument takes
 * Postgres's row lock for that document for the lifetime of the
 * transaction. Two concurrent calls for the SAME document therefore
 * serialize on that lock — the second one's UPDATE blocks until the first
 * transaction commits (run created) or rolls back (refused, and the
 * increment it made rolls back with it, so a refusal never burns an
 * attempt number), then re-reads a consistent view before deciding.
 * `@@unique([candidateDocumentId, attemptNumber])` remains as an
 * independent backstop in case this logic is ever bypassed.
 */
export async function startProcessingRun(candidateDocumentId: string): Promise<ProcessingRun> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.candidateDocument.update({
      where: { id: candidateDocumentId },
      data: { processingAttemptCounter: { increment: 1 } },
      select: { processingAttemptCounter: true },
    });

    const existingRunning = await tx.processingRun.findFirst({
      where: { candidateDocumentId, status: "RUNNING" },
    });
    if (existingRunning) {
      throw new ProcessingRunAlreadyActiveError(candidateDocumentId);
    }

    return tx.processingRun.create({
      data: { candidateDocumentId, attemptNumber: updated.processingAttemptCounter, status: "RUNNING" },
    });
  });
}

/**
 * Marks a run FAILED. Deliberately does NOT touch
 * CandidateDocument.currentProcessingRunId — a failed run must never
 * become (or replace) the current run; the pointer is left exactly as it
 * was, whether that's a previous successful run or null.
 */
export async function failProcessingRun(processingRunId: string): Promise<void> {
  await prisma.processingRun.update({
    where: { id: processingRunId },
    data: { status: "FAILED", completedAt: new Date() },
  });
}

/**
 * Marks a run COMPLETED and promotes it to the document's current run, in
 * one transaction — the exact atomicity the design requires: a reader can
 * never observe a run marked COMPLETED whose document doesn't yet (or
 * simultaneously) point at it as current, and vice versa. If this
 * transaction fails for any reason, neither write applies — the previous
 * currentProcessingRunId (or null) stands, and the run stays RUNNING,
 * which a later retry's startProcessingRun will clean up.
 */
export async function completeProcessingRun(processingRunId: string, candidateDocumentId: string): Promise<void> {
  const completedAt = new Date();
  await prisma.$transaction([
    prisma.processingRun.update({
      where: { id: processingRunId },
      data: { status: "COMPLETED", completedAt },
    }),
    prisma.candidateDocument.update({
      where: { id: candidateDocumentId },
      data: { currentProcessingRunId: processingRunId, status: "COMPLETED" },
    }),
  ]);
}

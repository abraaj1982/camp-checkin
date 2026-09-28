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
 *
 * Phase 10 — Ownership enforcement (10A.1/10A.2, approved). The
 * authoritative ownership condition: a run may perform an authoritative
 * write only while, evaluated atomically at write time,
 * `ProcessingRun.id = <this run> AND ProcessingRun.status = 'RUNNING'`
 * still holds. Once a run is reclaimed, fails, or completes, that
 * condition can never become true again for it (terminal states are never
 * re-opened), so any later write attempted "as" that run is structurally
 * unable to succeed. This is enforced via guarded, count-checked
 * updates — never a standalone pre-check followed by a separate write,
 * which would leave a TOCTOU window between the check and the write.
 */

export class ProcessingRunAlreadyActiveError extends Error {
  constructor(public readonly candidateDocumentId: string) {
    super(`A ProcessingRun is already RUNNING for CandidateDocument ${candidateDocumentId}`);
    this.name = "ProcessingRunAlreadyActiveError";
  }
}

/**
 * Thrown whenever a write attempted "as" a given ProcessingRun discovers,
 * atomically, that the run is no longer RUNNING — reclaimed, superseded,
 * or otherwise no longer the owner of its CandidateDocument. Callers must
 * treat this as a clean no-op (Phase 10A.2, approved): never call
 * failProcessingRun again for it, never touch CandidateDocument.status,
 * never retry — the run that superseded this one (or the reclaim that
 * ended it) is already responsible for the document's current state.
 */
export class ProcessingRunNoLongerActiveError extends Error {
  constructor(public readonly processingRunId: string) {
    super(`ProcessingRun ${processingRunId} is no longer RUNNING — write aborted`);
    this.name = "ProcessingRunNoLongerActiveError";
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
 *      triggers deliberately — the existing HR "retry a FAILED_RETRY
 *      document" route only starts a new run once the CandidateDocument
 *      itself is already off PROCESSING; it does not touch a RUNNING
 *      ProcessingRun row at all.
 *   3. The Phase 10 stale-run reclaim mechanism — a scheduled scan that
 *      transitions a RUNNING run whose startedAt exceeds a configured
 *      threshold to FAILED, using the same guarded transition as every
 *      other path (never a different write shape).
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
 * Atomically transitions a run to FAILED, but ONLY if it is still
 * RUNNING — `updateMany` with `status: "RUNNING"` in the WHERE clause is
 * the whole guard, in one statement, no separate pre-check. Returns
 * whether THIS call performed the transition: `true` means the run was
 * genuinely RUNNING and is now FAILED (the normal case — the run
 * reporting its own outcome, or a reclaim ending a stale one); `false`
 * means it was already terminal (already reclaimed, already failed by
 * someone else, or — for completeProcessingRun's own guard — already
 * completed) and this call changed nothing. Never touches
 * CandidateDocument — callers that also need to update the document must
 * do so themselves, informed by this return value.
 */
export async function failProcessingRun(processingRunId: string): Promise<boolean> {
  const { count } = await prisma.processingRun.updateMany({
    where: { id: processingRunId, status: "RUNNING" },
    data: { status: "FAILED", completedAt: new Date() },
  });
  return count === 1;
}

/**
 * Marks a run COMPLETED and promotes it to the document's current run, in
 * one transaction — the exact atomicity the design requires: a reader can
 * never observe a run marked COMPLETED whose document doesn't yet (or
 * simultaneously) point at it as current, and vice versa.
 *
 * Phase 10 ownership guard: the FIRST statement in the transaction is a
 * guarded `updateMany(... WHERE status = 'RUNNING')` on the run itself —
 * same-table, no cross-table EXISTS needed. If it affects zero rows (the
 * run was already reclaimed/failed/completed by something else), this
 * function throws ProcessingRunNoLongerActiveError and the transaction
 * rolls back — the CandidateDocument update is never reached, so a
 * reclaimed run can never promote itself to "current" after the fact.
 * If it succeeds, Postgres holds that row's lock for the remainder of
 * this (short, post-AI-call) transaction, so nothing else can contend for
 * ownership of this run between the guard and the CandidateDocument
 * write — no separate FOR UPDATE lock is needed to achieve this; it falls
 * out of the guarded UPDATE itself.
 */
export async function completeProcessingRun(processingRunId: string, candidateDocumentId: string): Promise<void> {
  const completedAt = new Date();
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.processingRun.updateMany({
      where: { id: processingRunId, status: "RUNNING" },
      data: { status: "COMPLETED", completedAt },
    });
    if (count === 0) {
      throw new ProcessingRunNoLongerActiveError(processingRunId);
    }
    await tx.candidateDocument.update({
      where: { id: candidateDocumentId },
      data: { currentProcessingRunId: processingRunId, status: "COMPLETED" },
    });
  });
}

/**
 * The ownership guard used inside every multi-statement, post-AI-call
 * transaction that writes Evidence/Assessment/CandidateConsistencyFinding
 * or candidate-profile rows (Phase 10A.1 write map). Must be the FIRST
 * statement of the caller's `prisma.$transaction(async (tx) => ...)`
 * callback, passed that same `tx`. Performs a same-table, no-op-value
 * guarded update (`status: "RUNNING" -> "RUNNING"`) purely to atomically
 * re-affirm ownership and take Postgres's row lock on this run for the
 * rest of the transaction — every write that follows is therefore
 * protected without a transaction-long `SELECT ... FOR UPDATE` and
 * without a separate pre-check that could go stale before the real write
 * happens. Throws ProcessingRunNoLongerActiveError (which rolls back
 * everything already done in this transaction, including this call
 * itself) if the run is no longer RUNNING.
 *
 * Safe to hold this lock for the remainder of these specific
 * transactions because none of them span an AI Gateway call — every
 * `gateway.runTask()` in this codebase is awaited BEFORE its caller's
 * `$transaction` block opens, so the transactions this guard protects are
 * always short (parse-result/profile/evidence writes only), never the
 * multi-hour worst case an AI call could take. A transaction-long lock
 * would be unsafe for exactly that reason if it were ever wrapped around
 * an AI call — it must never be.
 */
export async function assertProcessingRunStillRunning(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  processingRunId: string,
): Promise<void> {
  const { count } = await tx.processingRun.updateMany({
    where: { id: processingRunId, status: "RUNNING" },
    data: { status: "RUNNING" },
  });
  if (count === 0) {
    throw new ProcessingRunNoLongerActiveError(processingRunId);
  }
}

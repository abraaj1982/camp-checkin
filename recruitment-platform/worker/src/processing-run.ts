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
 *   3. The Phase 10D stale-run reclaim mechanism (reclaimProcessingRun,
 *      below) — a scheduled scan that transitions a RUNNING run whose
 *      heartbeatAt has fallen behind STALE_THRESHOLD_MS to FAILED, using
 *      the same guarded transition as every other path (never a different
 *      write shape).
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

    // Phase 10D — heartbeatAt is set here, at creation, to the same moment
    // as startedAt — never left null. This is the chosen NULL-safety
    // strategy: a fresh run's "age since last heartbeat" is 0 the instant
    // it's created, so findStaleProcessingRunIds()'s plain
    // `heartbeatAt < cutoff` comparison can never mistake a just-started
    // run for stale, with no separate NULL-handling branch and no second,
    // independent staleness signal (e.g. falling back to startedAt) —
    // heartbeatAt is the only field reclaim ever reads.
    const now = new Date();
    return tx.processingRun.create({
      data: {
        candidateDocumentId,
        attemptNumber: updated.processingAttemptCounter,
        status: "RUNNING",
        heartbeatAt: now,
      },
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

/**
 * Phase 10D — ProcessingRun heartbeat & stale reclaim.
 *
 * The heartbeat answers "is the worker/run still alive?" — it is
 * deliberately NOT a whole-run duration limit; a legitimately long-running
 * run (e.g. a slow but healthy AI call) keeps refreshing heartbeatAt
 * indefinitely and is never reclaimed. Reclaim answers a different
 * question ("has this run stopped proving it's alive?"), using the same
 * heartbeatAt field as its sole signal — one mechanism, not two.
 */
export const HEARTBEAT_INTERVAL_MS = 30_000;
export const STALE_THRESHOLD_MS = 3 * 60_000;

/**
 * Guarded heartbeat write — same idiom as every other Phase 10 write:
 * `WHERE id = ? AND status = 'RUNNING'`. Never resurrects or modifies a
 * terminal run (a FAILED/COMPLETED row simply doesn't match the WHERE
 * clause, so this is a no-op, not an error). Returns whether the run is
 * still owned by this heartbeat; `false` tells the caller (startHeartbeat)
 * to stop ticking — Phase 10B's existing ownership guards are what
 * actually neutralize any of this worker's subsequent writes, not this
 * function.
 */
export async function updateHeartbeat(processingRunId: string): Promise<boolean> {
  const { count } = await prisma.processingRun.updateMany({
    where: { id: processingRunId, status: "RUNNING" },
    data: { heartbeatAt: new Date() },
  });
  return count === 1;
}

export interface HeartbeatHandle {
  stop(): void;
}

/**
 * Starts a heartbeat for `processingRunId`, ticking every `intervalMs`
 * (default HEARTBEAT_INTERVAL_MS). Deliberately a single independent
 * timer for the run's entire lifetime — NOT tied to AI-call or
 * pipeline-stage boundaries, so a single long-running stage never starves
 * it (a checkpoint-only heartbeat would falsely go stale mid-stage; see
 * Phase 10C.1/10C.2). Caller MUST call `.stop()` in a `finally` block
 * covering every exit path (success, OCR terminal, ordinary failure,
 * ProcessingRunNoLongerActiveError, any other thrown error) to avoid a
 * timer leak — this function does not know when the pipeline is done.
 *
 * A heartbeat DB write failure (e.g. a transient outage) is caught and
 * logged, never thrown — it must not fail the ProcessingRun; the next
 * tick simply tries again. Uses plain `setInterval`/`clearInterval` (no
 * new dependency), so it's directly testable with fake timers.
 */
export function startHeartbeat(processingRunId: string, intervalMs: number = HEARTBEAT_INTERVAL_MS): HeartbeatHandle {
  let stopped = false;
  const timer = setInterval(() => {
    if (stopped) return;
    updateHeartbeat(processingRunId)
      .then((stillOwned) => {
        if (!stillOwned && !stopped) {
          // No longer RUNNING (reclaimed, failed, or completed by
          // something else) — stop ticking. Deliberately does nothing
          // else here: Phase 10B's guards are what make any of this
          // worker's remaining writes harmless, not this timer.
          stopped = true;
          clearInterval(timer);
        }
      })
      .catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[processing-run] heartbeat write failed; will retry next tick", {
          processingRunId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }, intervalMs);
  // Never let this timer alone keep the Node process alive.
  timer.unref?.();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

/** Finds RUNNING runs whose heartbeatAt has fallen behind `cutoff` — candidates for reclaim. heartbeatAt is never null for a RUNNING run (see startProcessingRun), so no NULL-handling branch is needed. */
export async function findStaleProcessingRunIds(
  cutoff: Date,
  limit = 100,
): Promise<{ id: string; candidateDocumentId: string }[]> {
  return prisma.processingRun.findMany({
    where: { status: "RUNNING", heartbeatAt: { lt: cutoff } },
    select: { id: true, candidateDocumentId: true },
    take: limit,
  });
}

/**
 * Reclaims one stale run: ProcessingRun RUNNING -> FAILED AND
 * CandidateDocument -> FAILED_RETRY, atomically, in one transaction, with
 * the ProcessingRun guard as the first statement (same ownership
 * philosophy as completeProcessingRun/the OCR branch in pipeline.ts).
 *
 * The guard re-checks `heartbeatAt < cutoff` (the SAME cutoff the scan
 * that selected this run used), not just `status = RUNNING` — closing the
 * scan-to-reclaim race where the owning worker successfully heartbeats
 * between the scan and this call. If the run proved liveness in that
 * window, this guard no longer matches it (count === 0) and reclaim is
 * correctly refused, leaving the run RUNNING and the document untouched.
 *
 * Safe under concurrent reclaimers targeting the same run: only the
 * transaction that wins the guarded `updateMany` (count === 1) proceeds
 * to touch CandidateDocument; a losing concurrent attempt sees count ===
 * 0, returns false, and never writes CandidateDocument at all — so no
 * partial state (ProcessingRun FAILED while CandidateDocument still reads
 * PROCESSING) can ever result from this operation. No automatic requeue —
 * the document is left exactly where the existing manual retry route
 * already knows how to pick it up from.
 */
export async function reclaimProcessingRun(
  processingRunId: string,
  candidateDocumentId: string,
  cutoff: Date,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const { count } = await tx.processingRun.updateMany({
      where: { id: processingRunId, status: "RUNNING", heartbeatAt: { lt: cutoff } },
      data: { status: "FAILED", completedAt: new Date() },
    });
    if (count === 0) return false; // already reclaimed/failed/completed, or heartbeated fresh since the scan — harmless no-op
    await tx.candidateDocument.update({
      where: { id: candidateDocumentId },
      data: {
        status: "FAILED_RETRY",
        failureReason: "Processing run reclaimed: no heartbeat received within the stale threshold.",
      },
    });
    return true;
  });
}

/** The scheduled reclaim scan: finds stale runs and reclaims each independently, using one cutoff computed once for the whole scan so a reclaim never targets a run against a later (recomputed) cutoff than the one that selected it. */
export async function runReclaimScan(limit = 100): Promise<{ scanned: number; reclaimed: number }> {
  const cutoff = new Date(Date.now() - STALE_THRESHOLD_MS);
  const stale = await findStaleProcessingRunIds(cutoff, limit);
  let reclaimed = 0;
  for (const run of stale) {
    if (await reclaimProcessingRun(run.id, run.candidateDocumentId, cutoff)) reclaimed += 1;
  }
  return { scanned: stale.length, reclaimed };
}

/**
 * Phase 10A/11 — Candidate Profile Publication Authority.
 *
 * Guards whether THIS run is allowed to replace the candidate's
 * consolidated profile (CandidateExperience/Education/Skill/Certification/
 * Language) — a distinct question from ProcessingRun ownership
 * (assertProcessingRunStillRunning, above): a run can legitimately still
 * own itself while NOT being authoritative for the candidate-wide profile
 * (Phase 10A.5 Section 4). Must be called as the first write inside the
 * SAME transaction as the profile deletes/creates that follow it, and
 * BEFORE any of them — a CAS failure here must leave every profile table
 * and Candidate.currentProfile* field completely untouched (Phase 10A.7
 * Section 7 / Phase 10A.8 Section 7).
 *
 * Authority ordering (Phase 10A.5-10A.10, approved, Policy C ratified):
 *   1. no prior publication (currentProfileDocumentId IS NULL) -> always wins
 *   2. a strictly newer CandidateDocument.uploadedAt -> always wins,
 *      regardless of attemptNumber or arrival/commit order
 *   3. equal uploadedAt, different document (realistic under batch upload,
 *      Phase 10A.8 Section 6 — millisecond precision) -> deterministic
 *      tie-break on CandidateDocument.id (no business meaning, purely a
 *      total-order tie-breaker)
 *   4. the SAME document, a strictly greater attemptNumber (Policy C,
 *      ratified) -> a later successful retry of the currently-authoritative
 *      document may refresh the profile; ProcessingRun.attemptNumber is
 *      unique per document (@@unique([candidateDocumentId, attemptNumber])),
 *      so no tie-break is ever needed for this branch.
 *
 * All four Candidate.currentProfile* fields are read from THIS run's own,
 * already-immutable identity (its own document's id/uploadedAt, its own
 * id, its own attemptNumber) and written together in one guarded
 * updateMany's SET clause — never independently, never re-derived from
 * unrelated live state — so the invariant "currentProfileAttemptNumber ==
 * attemptNumber of the ProcessingRun referenced by
 * currentProfileProcessingRunId" (and the equivalent for
 * currentProfileUploadedAt/currentProfileDocumentId) holds by construction:
 * a single UPDATE statement cannot partially apply its SET clause.
 */
export async function tryPublishCandidateProfile(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  params: {
    candidateId: string;
    newDocumentId: string;
    newUploadedAt: Date;
    newRunId: string;
    newAttemptNumber: number;
  },
): Promise<boolean> {
  const { candidateId, newDocumentId, newUploadedAt, newRunId, newAttemptNumber } = params;
  const { count } = await tx.candidate.updateMany({
    where: {
      id: candidateId,
      OR: [
        { currentProfileDocumentId: null },
        { currentProfileUploadedAt: { lt: newUploadedAt } },
        { currentProfileUploadedAt: newUploadedAt, currentProfileDocumentId: { lt: newDocumentId } },
        { currentProfileDocumentId: newDocumentId, currentProfileAttemptNumber: { lt: newAttemptNumber } },
      ],
    },
    data: {
      currentProfileDocumentId: newDocumentId,
      currentProfileUploadedAt: newUploadedAt,
      currentProfileProcessingRunId: newRunId,
      currentProfileAttemptNumber: newAttemptNumber,
    },
  });
  return count === 1;
}

/**
 * Item 16 (Option B) — Project-Scoped Candidate Profile Authority. Exact
 * re-scoping of tryPublishCandidateProfile's own CAS (same four branches,
 * same NULL-initial-state/uploadedAt/documentId-tie-break/attemptNumber-
 * tie-break ordering — no new policy), keyed by (candidateId, projectId)
 * instead of candidateId alone, because Assessment/Evidence/
 * CandidateConsistencyFinding are project-scoped while
 * Candidate.currentProfile* is candidate-global and gates a different,
 * unrelated concern (the candidate-wide consolidated profile tables —
 * unchanged, untouched by this function). The CandidateProjectAuthority
 * row for this (candidateId, projectId) must already exist (created
 * alongside its CandidateProjectLink — see worker/src/identity-resolution.ts
 * and apps/api's candidate-match-reviews routes) — this function only ever
 * updates an existing row, never upserts one.
 */
export async function tryPublishCandidateProjectAuthority(
  tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
  params: {
    candidateId: string;
    projectId: string;
    newDocumentId: string;
    newUploadedAt: Date;
    newRunId: string;
    newAttemptNumber: number;
  },
): Promise<boolean> {
  const { candidateId, projectId, newDocumentId, newUploadedAt, newRunId, newAttemptNumber } = params;
  const { count } = await tx.candidateProjectAuthority.updateMany({
    where: {
      candidateId,
      projectId,
      OR: [
        { currentDocumentId: null },
        { currentUploadedAt: { lt: newUploadedAt } },
        { currentUploadedAt: newUploadedAt, currentDocumentId: { lt: newDocumentId } },
        { currentDocumentId: newDocumentId, currentAttemptNumber: { lt: newAttemptNumber } },
      ],
    },
    data: {
      currentDocumentId: newDocumentId,
      currentUploadedAt: newUploadedAt,
      currentProcessingRunId: newRunId,
      currentAttemptNumber: newAttemptNumber,
    },
  });
  return count === 1;
}

import { prisma, recordAudit } from "@recruitment-platform/db";
import type { ObjectStorage } from "@recruitment-platform/storage";

/**
 * Phase 8 — PII Retention / Purge.
 *
 * One shared execution path for both the manual admin endpoint
 * (apps/api/src/modules/candidate-purge/routes.ts) and the scheduled
 * worker scan (worker/src/index.ts, via pg-boss.schedule()) — per the
 * approved architecture, there is exactly one eligibility predicate and
 * exactly one purge implementation, never two.
 *
 * Eligibility (Phase 8A, final):
 *   A Candidate is purge-eligible only when:
 *     1. it has at least one CandidateProjectLink (zero links -> NOT
 *        eligible, never vacuously eligible);
 *     2. every one of its CandidateProjectLink rows is retention-eligible
 *        (see isProjectLinkEligible);
 *     3. no PENDING CandidateMatchReview references it via either
 *        emailMatchedCandidateId or phoneMatchedCandidateId;
 *     4. piiPurgedAt is still null.
 *
 *   A CandidateProjectLink is retention-eligible only when:
 *     1. its RecruitmentProject.status is COMPLETED or ARCHIVED;
 *     2. now() - (the project's terminal-entry timestamp) >= the
 *        project's effective retention window. The terminal-entry
 *        timestamp is read from the EXISTING, immutable AuditLog trail
 *        (action "PROJECT_STATUS_CHANGED"), never from `updatedAt` (which
 *        changes on unrelated project edits) and never a new field;
 *     3. none of the candidate's CandidateDocuments in that project has
 *        status QUEUED, PROCESSING, or FAILED_RETRY (FAILED_NEEDS_OCR is a
 *        dead end with no retry path at all — it does not block);
 *     4. no ProcessingRun with status RUNNING exists for any of the
 *        candidate's documents in that project.
 *
 * CandidateProjectLink.status is never read here — it carries no real
 * lifecycle meaning in this codebase (confirmed by inspection: nothing
 * else reads or writes it). Evidence/Assessment/HrDecision/
 * CandidateConsistencyFinding are never eligibility signals either — they
 * are historical facts, always preserved, never touched by purge.
 */

export const DEFAULT_RETENTION_DAYS = 365;

const ACTIVE_DOCUMENT_STATUSES = ["QUEUED", "PROCESSING", "FAILED_RETRY"] as const;
const TERMINAL_PROJECT_STATUSES = ["COMPLETED", "ARCHIVED"] as const;

/** Effective retention window for a project — fails closed on any invalid override. */
function effectiveRetentionDays(project: { retentionDays: number | null }): number | null {
  if (project.retentionDays === null) return DEFAULT_RETENTION_DAYS;
  if (!Number.isInteger(project.retentionDays) || project.retentionDays <= 0) return null; // fail closed
  return project.retentionDays;
}

/**
 * The immutable moment this project first entered a terminal status,
 * derived from the existing AuditLog trail rather than `updatedAt` (which
 * changes on any unrelated project edit). ALLOWED_STATUS_TRANSITIONS
 * (apps/api/src/modules/projects/routes.ts) never lets a project leave the
 * terminal set once entered, so the EARLIEST such entry is unambiguous.
 */
async function terminalEnteredAt(projectId: string): Promise<Date | null> {
  const entries = await prisma.auditLog.findMany({
    where: { entityType: "RecruitmentProject", entityId: projectId, action: "PROJECT_STATUS_CHANGED" },
    orderBy: { createdAt: "asc" },
    select: { createdAt: true, afterJson: true },
  });
  for (const entry of entries) {
    const status = (entry.afterJson as { status?: string } | null)?.status;
    if (status && (TERMINAL_PROJECT_STATUSES as readonly string[]).includes(status)) {
      return entry.createdAt;
    }
  }
  return null;
}

async function isProjectLinkEligible(candidateId: string, projectId: string): Promise<boolean> {
  const project = await prisma.recruitmentProject.findUnique({
    where: { id: projectId },
    select: { status: true, retentionDays: true },
  });
  if (!project) return false;
  if (!(TERMINAL_PROJECT_STATUSES as readonly string[]).includes(project.status)) return false;

  const retentionDays = effectiveRetentionDays(project);
  if (retentionDays === null) return false; // invalid override — fail closed

  const enteredAt = await terminalEnteredAt(projectId);
  if (!enteredAt) return false; // no confirmed terminal-entry record — fail closed
  const elapsedMs = Date.now() - enteredAt.getTime();
  if (elapsedMs < retentionDays * 24 * 60 * 60 * 1000) return false;

  const activeDocument = await prisma.candidateDocument.findFirst({
    where: { candidateId, projectId, status: { in: [...ACTIVE_DOCUMENT_STATUSES] } },
    select: { id: true },
  });
  if (activeDocument) return false;

  const runningRun = await prisma.processingRun.findFirst({
    where: { status: "RUNNING", candidateDocument: { candidateId, projectId } },
    select: { id: true },
  });
  if (runningRun) return false;

  return true;
}

export async function isCandidateEligibleForPurge(candidateId: string): Promise<boolean> {
  const candidate = await prisma.candidate.findUnique({
    where: { id: candidateId },
    select: { piiPurgedAt: true, projectLinks: { select: { projectId: true } } },
  });
  if (!candidate || candidate.piiPurgedAt !== null) return false;
  if (candidate.projectLinks.length === 0) return false; // zero links — INDETERMINATE / not eligible

  for (const link of candidate.projectLinks) {
    if (!(await isProjectLinkEligible(candidateId, link.projectId))) return false;
  }

  const pendingReview = await prisma.candidateMatchReview.findFirst({
    where: {
      status: "PENDING",
      OR: [{ emailMatchedCandidateId: candidateId }, { phoneMatchedCandidateId: candidateId }],
    },
    select: { id: true },
  });
  if (pendingReview) return false;

  return true;
}

/** Scans all not-yet-purged candidates and returns the ids that are currently eligible, bounded by `limit`. */
export async function findEligibleCandidateIds(limit = 100): Promise<string[]> {
  const candidates = await prisma.candidate.findMany({
    where: { piiPurgedAt: null, projectLinks: { some: {} } },
    select: { id: true },
  });
  const eligible: string[] = [];
  for (const candidate of candidates) {
    if (eligible.length >= limit) break;
    if (await isCandidateEligibleForPurge(candidate.id)) eligible.push(candidate.id);
  }
  return eligible;
}

export type PurgeTrigger = "MANUAL" | "SCHEDULED";
export type PurgeResult =
  | { status: "PURGED"; documentCount: number }
  | { status: "ALREADY_PURGED" }
  | { status: "NOT_ELIGIBLE" };

/**
 * The one shared purge implementation. DB-first, storage-second (Phase 8A
 * Decision): Step 1 atomically anonymizes Candidate PII (the point of no
 * return); Step 2, outside that transaction, deletes each document's
 * stored object and marks CandidateDocument.purgedAt — idempotently, so an
 * interruption anywhere in Step 2 self-heals on the next call to
 * recoverInterruptedPurges() with zero new schema (Phase 8A: no
 * purge-state/recovery field is needed — `piiPurgedAt IS NOT NULL AND
 * purgedAt IS NULL` IS the recovery signal).
 */
export async function executeCandidatePurge(
  candidateId: string,
  trigger: PurgeTrigger,
  actorId: string | null,
  deps: { storage: ObjectStorage },
): Promise<PurgeResult> {
  const eligible = await isCandidateEligibleForPurge(candidateId);
  if (!eligible) {
    const already = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { piiPurgedAt: true } });
    if (already?.piiPurgedAt) return { status: "ALREADY_PURGED" };
    return { status: "NOT_ELIGIBLE" };
  }

  // Atomic claim — same idiom as every other Phase 4A/6/7 guarded write:
  // only one concurrent manual/scheduled attempt can ever win this update.
  const claim = await prisma.candidate.updateMany({
    where: { id: candidateId, piiPurgedAt: null },
    data: {
      piiPurgedAt: new Date(),
      fullName: "[purged]",
      email: null,
      phone: null,
      normalizedEmail: null,
      normalizedPhone: null,
    },
  });
  if (claim.count === 0) return { status: "ALREADY_PURGED" };

  const documents = await prisma.candidateDocument.findMany({
    where: { candidateId },
    select: { id: true, projectId: true },
  });
  const projectIds = [...new Set(documents.map((d) => d.projectId).filter((id): id is string => id !== null))];

  // Phase 8C fix: per-document failure isolation — one document's storage
  // failure must never abort the rest of the loop, and the purge event's
  // ONE audit record must always be written (after every document has been
  // independently attempted), regardless of any individual failure. The
  // atomic claim above has already committed at this point, so the audit
  // must reflect reality (SUCCESS/PARTIAL/FAILED), never silently vanish.
  const { failedDocumentIds } = await purgeDocumentObjects(documents.map((d) => d.id), deps.storage);

  const result =
    failedDocumentIds.length === 0
      ? "SUCCESS"
      : failedDocumentIds.length === documents.length
        ? "FAILED"
        : "PARTIAL";

  await recordAudit({
    actorId,
    action: "CANDIDATE_PII_PURGED",
    entityType: "Candidate",
    entityId: candidateId,
    after: {
      projectIdsCausingEligibility: projectIds,
      trigger,
      documentIds: documents.map((d) => d.id),
      documentCount: documents.length,
      failedDocumentIds,
      result,
    },
  });

  return { status: "PURGED", documentCount: documents.length };
}

/**
 * Deletes each document's stored object and marks purgedAt, idempotently —
 * safe to call for already-purged documents (no-op) and safe to re-call
 * after a partial failure. Each document is attempted independently: a
 * thrown storage error for one document is caught and recorded, never
 * aborting the remaining documents in the same call (Phase 8C fix).
 */
async function purgeDocumentObjects(
  documentIds: string[],
  storage: ObjectStorage,
): Promise<{ failedDocumentIds: string[] }> {
  const failedDocumentIds: string[] = [];
  for (const documentId of documentIds) {
    try {
      const document = await prisma.candidateDocument.findUnique({
        where: { id: documentId },
        select: { storageKey: true, purgedAt: true },
      });
      if (!document || document.purgedAt !== null) continue; // already handled

      await storage.deleteObject(document.storageKey); // idempotent — safe even if already deleted
      await prisma.candidateDocument.updateMany({
        where: { id: documentId, purgedAt: null },
        data: { purgedAt: new Date() },
      });
    } catch {
      failedDocumentIds.push(documentId); // isolated — remaining documents are still attempted below
    }
  }
  return { failedDocumentIds };
}

/**
 * Recovers any purge interrupted between Step 1 and Step 2 (or mid-Step-2)
 * — finds every CandidateDocument whose Candidate is already purged but
 * whose own object hasn't been confirmed deleted yet, and retries. Run at
 * the start of every scheduled scan.
 */
export async function recoverInterruptedPurges(storage: ObjectStorage): Promise<number> {
  const pending = await prisma.candidateDocument.findMany({
    where: { purgedAt: null, candidate: { piiPurgedAt: { not: null } } },
    select: { id: true },
  });
  await purgeDocumentObjects(pending.map((d) => d.id), storage);
  return pending.length;
}

/** The scheduled scan: recover first, then purge every currently-eligible candidate. Shares executeCandidatePurge with the manual endpoint. */
export async function runScheduledPurgeScan(deps: { storage: ObjectStorage }, limit = 100): Promise<{ recovered: number; purged: number }> {
  const recovered = await recoverInterruptedPurges(deps.storage);
  const eligibleIds = await findEligibleCandidateIds(limit);
  let purged = 0;
  for (const candidateId of eligibleIds) {
    const result = await executeCandidatePurge(candidateId, "SCHEDULED", null, deps);
    if (result.status === "PURGED") purged += 1;
  }
  return { recovered, purged };
}

import { prisma, recordAudit } from "@recruitment-platform/db";
import type { ObjectStorage } from "@recruitment-platform/storage";
import type { CandidateDocumentQueue } from "@recruitment-platform/queue";
import { deriveFullNameFromFilename } from "@recruitment-platform/shared-types";
import { parseDocument, extractIdentity } from "@recruitment-platform/document-parsing";

/**
 * Phase 7 — Candidate Deduplication / Reuse across Projects.
 *
 * Runs BEFORE any Candidate-scoped row exists for this upload. Deterministic
 * only — no AI Gateway call anywhere in this module, no identity data ever
 * sent to one (Phase 7A). Both email and phone matches are always evaluated
 * — never short-circuited — because matchSignal classification (and the
 * CONFLICT case in particular) depends on knowing the result of both.
 *
 * No match at all -> promotes immediately (Candidate/Link/CandidateDocument
 * created here, in the worker, mirroring exactly what the API upload route
 * used to do inline). A match on either signal -> creates a
 * CandidateMatchReview and stops; nothing Candidate-scoped is created until
 * an HR_ADMIN/SYSTEM_ADMIN resolves it (apps/api/src/modules/
 * candidate-match-reviews/routes.ts).
 */
export async function runIdentityResolutionPipeline(
  data: { stagedUploadId: string; projectId: string },
  deps: { storage: ObjectStorage; queue: CandidateDocumentQueue },
): Promise<void> {
  // Atomic claim — same idiom as the existing CandidateDocument retry
  // route's compare-and-set: only one concurrent job attempt for this
  // StagedUpload can ever proceed past this point.
  const claim = await prisma.stagedUpload.updateMany({
    where: { id: data.stagedUploadId, status: "PENDING_IDENTITY_RESOLUTION" },
    data: { status: "RESOLVING" },
  });
  if (claim.count === 0) return; // already claimed by another attempt, or already resolved — no-op

  const stagedUpload = await prisma.stagedUpload.findUniqueOrThrow({ where: { id: data.stagedUploadId } });

  try {
    const buffer = await deps.storage.getObject(stagedUpload.storageKey);
    const parsed = await parseDocument(buffer, stagedUpload.fileType === "pdf" ? "pdf" : "docx");
    const identity = extractIdentity(parsed.text);

    // Both signals evaluated unconditionally, every time — never
    // short-circuited on the first hit. This is a hard invariant: without
    // it, a CONFLICT (email matches candidate A, phone matches a
    // DIFFERENT candidate B) could be silently misclassified as a single
    // safe match, which is exactly what the matchSignal-gated identity-
    // enrichment rule (candidate-match-reviews/routes.ts) depends on never
    // happening.
    const emailMatch = identity.normalizedEmail
      ? await prisma.candidate.findFirst({
          where: { normalizedEmail: identity.normalizedEmail, piiPurgedAt: null },
          select: { id: true },
        })
      : null;
    const phoneMatch = identity.normalizedPhone
      ? await prisma.candidate.findFirst({
          where: { normalizedPhone: identity.normalizedPhone, piiPurgedAt: null },
          select: { id: true },
        })
      : null;

    if (!emailMatch && !phoneMatch) {
      await promoteWithNewCandidate(stagedUpload, identity, deps.queue);
      return;
    }

    const matchSignal =
      emailMatch && phoneMatch
        ? emailMatch.id === phoneMatch.id
          ? "BOTH"
          : "CONFLICT"
        : emailMatch
          ? "EMAIL"
          : "PHONE";

    await prisma.candidateMatchReview.create({
      data: {
        stagedUploadId: stagedUpload.id,
        projectId: stagedUpload.projectId,
        matchSignal,
        emailMatchedCandidateId: emailMatch?.id ?? null,
        phoneMatchedCandidateId: phoneMatch?.id ?? null,
      },
    });
    await prisma.stagedUpload.update({ where: { id: stagedUpload.id }, data: { status: "PENDING_REVIEW" } });

    await recordAudit({
      actorId: null,
      action: "CANDIDATE_MATCH_REVIEW_CREATED",
      entityType: "StagedUpload",
      entityId: stagedUpload.id,
      after: { projectId: stagedUpload.projectId, matchSignal },
    });
  } catch (err) {
    await prisma.stagedUpload.update({
      where: { id: stagedUpload.id },
      data: {
        status: "FAILED",
        failureReason: err instanceof Error ? err.message : "Unknown identity resolution error",
      },
    });
  }
}

async function promoteWithNewCandidate(
  stagedUpload: { id: string; projectId: string; batchId: string | null; storageKey: string; originalFilename: string; fileType: string; fileSizeBytes: number | null; uploadedBy: string; uploadedAt: Date },
  identity: { rawEmail: string | null; rawPhone: string | null; normalizedEmail: string | null; normalizedPhone: string | null },
  queue: CandidateDocumentQueue,
): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const candidate = await tx.candidate.create({
      data: {
        fullName: deriveFullNameFromFilename(stagedUpload.originalFilename),
        email: identity.rawEmail,
        phone: identity.rawPhone,
        normalizedEmail: identity.normalizedEmail,
        normalizedPhone: identity.normalizedPhone,
      },
    });

    const linkCount = await tx.candidateProjectLink.count({ where: { projectId: stagedUpload.projectId } });
    await tx.candidateProjectLink.create({
      data: {
        candidateId: candidate.id,
        projectId: stagedUpload.projectId,
        anonymizedLabel: `Candidate #${String(linkCount + 1).padStart(3, "0")}`,
      },
    });

    const document = await tx.candidateDocument.create({
      data: {
        candidateId: candidate.id,
        projectId: stagedUpload.projectId,
        batchId: stagedUpload.batchId,
        fileType: stagedUpload.fileType,
        storageKey: stagedUpload.storageKey, // literal same key — never copied or moved
        originalFilename: stagedUpload.originalFilename,
        fileSizeBytes: stagedUpload.fileSizeBytes,
        uploadedBy: stagedUpload.uploadedBy,
        uploadedAt: stagedUpload.uploadedAt,
        status: "QUEUED",
        stagedUploadId: stagedUpload.id,
      },
    });

    await tx.stagedUpload.update({ where: { id: stagedUpload.id }, data: { status: "PROMOTED" } });

    return { candidateId: candidate.id, documentId: document.id };
  });

  // Audit + enqueue OUTSIDE the transaction — matches the existing
  // worker/src/pipeline.ts precedent exactly; same pre-existing, accepted
  // post-commit failure window (Phase 7A), not newly introduced here.
  await recordAudit({
    actorId: stagedUpload.uploadedBy,
    action: "CANDIDATE_PROMOTED_FROM_STAGED_UPLOAD",
    entityType: "Candidate",
    entityId: result.candidateId,
    after: { projectId: stagedUpload.projectId, documentId: result.documentId, stagedUploadId: stagedUpload.id },
  });
  await queue.enqueue({
    candidateDocumentId: result.documentId,
    candidateId: result.candidateId,
    projectId: stagedUpload.projectId,
  });
}

import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import type { ObjectStorage } from "@recruitment-platform/storage";
import type { CandidateDocumentQueue } from "@recruitment-platform/queue";
import { deriveFullNameFromFilename } from "@recruitment-platform/shared-types";
import { parseDocument, extractIdentity } from "@recruitment-platform/document-parsing";
import { requireRole } from "../auth/rbac.js";
import { recordAudit } from "../../lib/audit.js";

/**
 * Phase 7 — Candidate Deduplication. Admin-only resolution of a
 * CandidateMatchReview: the one surface in the whole system where
 * cross-project candidate identity disclosure is intentional (Phase 7A
 * Decision: HR_ADMIN/SYSTEM_ADMIN are the only existing roles the system
 * already treats as authorized across every project — no new role is
 * introduced here). Never returns a raw or normalized email/phone value —
 * only matchSignal (categorical) and the matched candidate's name.
 */

class AlreadyResolvedError extends Error {}
class InvalidLinkTargetError extends Error {}

async function reDeriveIdentity(storage: ObjectStorage, storageKey: string, fileType: string) {
  const buffer = await storage.getObject(storageKey);
  const parsed = await parseDocument(buffer, fileType === "pdf" ? "pdf" : "docx");
  return extractIdentity(parsed.text);
}

export async function registerCandidateMatchReviewRoutes(
  app: FastifyInstance,
  storage: ObjectStorage,
  queue: CandidateDocumentQueue,
): Promise<void> {
  app.get(
    "/admin/candidate-match-reviews",
    { preHandler: requireRole("HR_ADMIN", "SYSTEM_ADMIN") },
    async (request) => {
      const query = request.query as { status?: string };
      const status = query.status === "PENDING" ? "PENDING" : undefined;

      const reviews = await prisma.candidateMatchReview.findMany({
        where: status ? { status } : undefined,
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          projectId: true,
          project: { select: { title: true } },
          matchSignal: true,
          status: true,
          createdAt: true,
          stagedUpload: { select: { originalFilename: true } },
          emailMatchedCandidateId: true,
          emailMatchedCandidate: { select: { fullName: true } },
          phoneMatchedCandidateId: true,
          phoneMatchedCandidate: { select: { fullName: true } },
        },
      });

      // Explicit DTO — never a raw Prisma row, never a raw/normalized
      // email or phone value (Phase 7A Decision).
      return reviews.map((r) => ({
        reviewId: r.id,
        projectId: r.projectId,
        projectTitle: r.project.title,
        stagedUploadFilename: r.stagedUpload.originalFilename,
        matchSignal: r.matchSignal,
        status: r.status,
        createdAt: r.createdAt,
        emailMatch: r.emailMatchedCandidateId
          ? { candidateId: r.emailMatchedCandidateId, candidateName: r.emailMatchedCandidate!.fullName }
          : null,
        phoneMatch: r.phoneMatchedCandidateId
          ? { candidateId: r.phoneMatchedCandidateId, candidateName: r.phoneMatchedCandidate!.fullName }
          : null,
      }));
    },
  );

  app.post(
    "/admin/candidate-match-reviews/:id/resolve",
    { preHandler: requireRole("HR_ADMIN", "SYSTEM_ADMIN") },
    async (request, reply) => {
      const { id: reviewId } = request.params as { id: string };
      const body = request.body as { outcome?: unknown; candidateId?: unknown };
      const identity = request.session.get("identity")!;

      if (body.outcome !== "LINK_EXISTING" && body.outcome !== "CREATE_NEW") {
        return reply.code(400).send({ error: "invalid_outcome" });
      }
      const outcome = body.outcome;
      if (outcome === "LINK_EXISTING" && typeof body.candidateId !== "string") {
        return reply.code(400).send({ error: "candidate_id_required" });
      }

      try {
        const result = await prisma.$transaction(async (tx) => {
          // Atomic claim — the primary concurrency guard. A second
          // concurrent/duplicate resolve request for this review sees
          // count === 0 and never reaches any Candidate/CandidateDocument
          // write below (Phase 7A Decision 2 / this module's own review).
          const claim = await tx.candidateMatchReview.updateMany({
            where: { id: reviewId, status: "PENDING" },
            data: { status: outcome, resolvedBy: identity.userId, resolvedAt: new Date() },
          });
          if (claim.count === 0) throw new AlreadyResolvedError();

          const review = await tx.candidateMatchReview.findUniqueOrThrow({
            where: { id: reviewId },
            include: { stagedUpload: true },
          });
          const stagedUpload = review.stagedUpload;

          // Read-only storage operation, deliberately OUTSIDE the invariant
          // that this transaction only ever performs DB writes internally —
          // re-derives raw+normalized identity from the same immutable
          // stored object rather than persisting it anywhere in between
          // (Phase 7A approved data-minimization correction). A failure
          // here throws before any write, so it cannot corrupt the claim.
          const derived = await reDeriveIdentity(storage, stagedUpload.storageKey, stagedUpload.fileType);

          let candidateId: string;

          if (outcome === "LINK_EXISTING") {
            candidateId = body.candidateId as string;
            if (
              candidateId !== review.emailMatchedCandidateId &&
              candidateId !== review.phoneMatchedCandidateId
            ) {
              throw new InvalidLinkTargetError();
            }

            const existingLink = await tx.candidateProjectLink.findFirst({
              where: { candidateId, projectId: review.projectId },
            });
            if (!existingLink) {
              const linkCount = await tx.candidateProjectLink.count({ where: { projectId: review.projectId } });
              await tx.candidateProjectLink.create({
                data: {
                  candidateId,
                  projectId: review.projectId,
                  anonymizedLabel: `Candidate #${String(linkCount + 1).padStart(3, "0")}`,
                },
              });
            }

            // matchSignal-gated identity enrichment (Phase 7A CRITICAL
            // correction) — the field that CAUSED the match is always a
            // no-op (already identical on this candidate by definition of
            // matching). The OTHER field may be filled ONLY when
            // matchSignal proves it matched no other candidate at all.
            // CONFLICT never enriches either field, for either candidate.
            if (review.matchSignal === "EMAIL" && derived.rawPhone) {
              await tx.candidate.updateMany({
                where: { id: candidateId, normalizedPhone: null },
                data: { phone: derived.rawPhone, normalizedPhone: derived.normalizedPhone },
              });
            } else if (review.matchSignal === "PHONE" && derived.rawEmail) {
              await tx.candidate.updateMany({
                where: { id: candidateId, normalizedEmail: null },
                data: { email: derived.rawEmail, normalizedEmail: derived.normalizedEmail },
              });
            }
            // BOTH: both fields already set — no write. CONFLICT: no write, unconditionally.
          } else {
            const candidate = await tx.candidate.create({
              data: {
                fullName: deriveFullNameFromFilename(stagedUpload.originalFilename),
                email: derived.rawEmail,
                phone: derived.rawPhone,
                normalizedEmail: derived.normalizedEmail,
                normalizedPhone: derived.normalizedPhone,
              },
            });
            candidateId = candidate.id;

            const linkCount = await tx.candidateProjectLink.count({ where: { projectId: review.projectId } });
            await tx.candidateProjectLink.create({
              data: {
                candidateId,
                projectId: review.projectId,
                anonymizedLabel: `Candidate #${String(linkCount + 1).padStart(3, "0")}`,
              },
            });
          }

          const document = await tx.candidateDocument.create({
            data: {
              candidateId,
              projectId: review.projectId,
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

          return { candidateId, documentId: document.id, projectId: review.projectId, matchSignal: review.matchSignal };
        });

        // Audit + enqueue OUTSIDE the transaction — matches the existing
        // worker/src/pipeline.ts precedent (audit recorded after its own
        // transaction commits, not inside it). A failure in either of these
        // two steps does not roll back or corrupt the already-committed
        // promotion; it is the same pre-existing, accepted failure window
        // documented in Phase 7A (not newly introduced here).
        await recordAudit({
          actorId: identity.userId,
          action: "CANDIDATE_MATCH_REVIEW_RESOLVED",
          entityType: "CandidateMatchReview",
          entityId: reviewId,
          after: { outcome, matchSignal: result.matchSignal, candidateId: result.candidateId, documentId: result.documentId },
        });
        await queue.enqueue({
          candidateDocumentId: result.documentId,
          candidateId: result.candidateId,
          projectId: result.projectId,
        });

        return { candidateId: result.candidateId, documentId: result.documentId };
      } catch (err) {
        if (err instanceof AlreadyResolvedError) {
          return reply.code(409).send({ error: "already_resolved" });
        }
        if (err instanceof InvalidLinkTargetError) {
          return reply.code(400).send({ error: "invalid_link_target" });
        }
        throw err;
      }
    },
  );
}

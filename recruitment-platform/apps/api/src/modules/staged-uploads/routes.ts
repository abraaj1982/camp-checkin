import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import type { CandidateDocumentQueue } from "@recruitment-platform/queue";
import { requireProjectAccess } from "../projects/authorization.js";
import { recordAudit } from "../../lib/audit.js";

/**
 * Phase 7 — Candidate Deduplication. Ordinary project-member-facing surface
 * for staged uploads: a neutral status list and a retry action. Neither
 * endpoint ever discloses a review id, a matched candidate's identity, the
 * matching signal, or any other-project detail (Phase 7A Decision 5/6) —
 * only the fixed string below for a PENDING_REVIEW item. That disclosure
 * boundary is enforced here by construction: this module never selects
 * CandidateMatchReview at all.
 */
const PENDING_REVIEW_MESSAGE = "Possible duplicate detected — administrator review required.";

export async function registerStagedUploadRoutes(
  app: FastifyInstance,
  queue: CandidateDocumentQueue,
): Promise<void> {
  app.get(
    "/projects/:projectId/staged-uploads",
    { preHandler: requireProjectAccess() },
    async (request) => {
      const stagedUploads = await prisma.stagedUpload.findMany({
        where: { projectId: request.project!.id },
        orderBy: { uploadedAt: "desc" },
        select: { id: true, originalFilename: true, status: true, failureReason: true, uploadedAt: true },
      });

      return stagedUploads.map((s) => ({
        stagedUploadId: s.id,
        originalFilename: s.originalFilename,
        status: s.status,
        uploadedAt: s.uploadedAt,
        // Neutral, non-disclosing message — see module doc comment.
        message: s.status === "PENDING_REVIEW" ? PENDING_REVIEW_MESSAGE : null,
        failureReason: s.status === "FAILED" ? s.failureReason : null,
      }));
    },
  );

  app.post(
    "/projects/:projectId/staged-uploads/:id/retry",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const project = request.project!;
      const identity = request.session.get("identity")!;

      // Atomic compare-and-swap — same idiom as the existing CandidateDocument
      // retry route: two concurrent retries can never both re-queue this
      // StagedUpload, and this can only ever operate on the SAME staged
      // upload row (never creates a second one).
      const { count } = await prisma.stagedUpload.updateMany({
        where: { id, projectId: project.id, status: "FAILED" },
        data: { status: "PENDING_IDENTITY_RESOLUTION", failureReason: null },
      });
      if (count === 0) {
        const stagedUpload = await prisma.stagedUpload.findFirst({ where: { id, projectId: project.id } });
        if (!stagedUpload) return reply.code(404).send({ error: "staged_upload_not_found" });
        return reply.code(400).send({ error: "not_retryable", status: stagedUpload.status });
      }

      await queue.enqueueIdentityResolution({ stagedUploadId: id, projectId: project.id });

      await recordAudit({
        actorId: identity.userId,
        action: "STAGED_UPLOAD_RETRY_REQUESTED",
        entityType: "StagedUpload",
        entityId: id,
      });

      return { status: "PENDING_IDENTITY_RESOLUTION" };
    },
  );
}

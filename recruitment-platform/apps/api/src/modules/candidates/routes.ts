import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import type { ObjectStorage } from "@recruitment-platform/storage";
import { buildStagedUploadKey } from "@recruitment-platform/storage";
import type { CandidateDocumentQueue } from "@recruitment-platform/queue";
import { validateUpload } from "@recruitment-platform/shared-types";
import { requireProjectAccess } from "../projects/authorization.js";
import { recordAudit } from "../../lib/audit.js";

const MAX_FILES_PER_BATCH = 30; // architecture doc: "approximately 10-30 CVs per recruitment project"

/**
 * Creates the batch and pins every currently-APPROVED requirement's latest
 * version to it (Phase 4 foundation, Decision 3) — resolved ONCE here, at
 * upload time, never re-queried per candidate later. A requirement with no
 * approved version yet (project still mid-setup) simply gets no pin; that's
 * fine — Phase 4's evidence-analysis code will have nothing to evaluate
 * that requirement against for this batch, which is the correct behavior
 * for an unapproved requirement.
 */
async function createUploadBatch(projectId: string, createdBy: string) {
  const batch = await prisma.candidateUploadBatch.create({ data: { projectId, createdBy } });

  const approvedRequirements = await prisma.jobRequirement.findMany({
    where: { projectId, status: "APPROVED", currentVersionNumber: { gt: 0 } },
  });

  for (const requirement of approvedRequirements) {
    const latestVersion = await prisma.jobRequirementVersion.findFirst({
      where: { requirementId: requirement.id },
      orderBy: { versionNumber: "desc" },
    });
    if (!latestVersion) continue; // shouldn't happen given currentVersionNumber > 0, but never assume

    await prisma.candidateBatchRequirementVersion.create({
      data: { batchId: batch.id, requirementId: requirement.id, requirementVersionId: latestVersion.id },
    });
  }

  return batch;
}

/**
 * Batch CV upload + per-candidate independent processing (architecture doc,
 * Section: Document Processing Pipeline / Batch Processing Architecture).
 * One candidate's invalid/corrupted file is reported and skipped — it never
 * fails the whole batch (Section 41).
 *
 * Phase 7 — Candidate Deduplication: this route no longer creates
 * Candidate/CandidateProjectLink/CandidateDocument directly. Identity is
 * unknown until the file is parsed, and parsing only happens in the
 * worker — so every accepted file becomes a StagedUpload (no candidateId)
 * and is handed to the new identity-resolution job, which either promotes
 * it immediately (no duplicate found) or creates a CandidateMatchReview
 * for an HR_ADMIN/SYSTEM_ADMIN to resolve. The response therefore can only
 * ever truthfully report "staged," never "a candidate now exists" — see
 * Phase 7A/7B: "staged"/"rejected" replace the old "uploaded"/"rejected"
 * buckets for exactly this reason.
 */
export async function registerCandidateRoutes(
  app: FastifyInstance,
  storage: ObjectStorage,
  queue: CandidateDocumentQueue,
): Promise<void> {
  app.post(
    "/projects/:projectId/candidates/upload",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const project = request.project!;
      const identity = request.session.get("identity")!;

      if (project.status === "ARCHIVED") {
        return reply.code(400).send({ error: "project_archived" });
      }

      const staged: { stagedUploadId: string; filename: string }[] = [];
      const rejected: { filename: string; error: string }[] = [];

      const batch = await createUploadBatch(project.id, identity.userId);

      let fileCount = 0;
      for await (const part of request.files()) {
        fileCount += 1;
        if (fileCount > MAX_FILES_PER_BATCH) {
          rejected.push({ filename: part.filename, error: "batch_limit_exceeded" });
          part.file.resume(); // drain the stream so the request can complete
          continue;
        }

        const buffer = await part.toBuffer();
        const validation = validateUpload({
          filename: part.filename,
          mimetype: part.mimetype,
          sizeBytes: buffer.byteLength,
          headerBytes: buffer.subarray(0, 8),
        });

        if (!validation.ok || !validation.fileType) {
          rejected.push({ filename: part.filename, error: validation.error ?? "invalid_file" });
          continue;
        }

        const stagedUpload = await prisma.stagedUpload.create({
          data: {
            projectId: project.id,
            batchId: batch.id,
            fileType: validation.fileType,
            // placeholder — replaced immediately below once we know the staged upload's own id
            storageKey: "pending",
            originalFilename: part.filename,
            fileSizeBytes: buffer.byteLength,
            uploadedBy: identity.userId,
          },
        });

        const storageKey = buildStagedUploadKey({
          projectId: project.id,
          stagedUploadId: stagedUpload.id,
          fileExtension: validation.fileType,
        });

        await storage.putObject({
          key: storageKey,
          body: buffer,
          contentType: validation.fileType === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        });

        await prisma.stagedUpload.update({ where: { id: stagedUpload.id }, data: { storageKey } });

        await queue.enqueueIdentityResolution({ stagedUploadId: stagedUpload.id, projectId: project.id });

        staged.push({ stagedUploadId: stagedUpload.id, filename: part.filename });
      }

      await recordAudit({
        actorId: identity.userId,
        action: "CANDIDATE_DOCUMENTS_UPLOADED",
        entityType: "RecruitmentProject",
        entityId: project.id,
        after: { batchId: batch.id, stagedCount: staged.length, rejectedCount: rejected.length },
      });

      return { batchId: batch.id, staged, rejected };
    },
  );

  app.get(
    "/projects/:projectId/candidates",
    { preHandler: requireProjectAccess() },
    async (request) => {
      // Explicit select + explicit response mapping (Phase 5C hardening) —
      // never `include` + raw-return here. The candidates management UI
      // only ever reads anonymizedLabel and each document's
      // id/originalFilename/fileType/status/failureReason/uploadedAt; this
      // route must not send anything beyond that over the wire, regardless
      // of what the UI currently chooses to render. Candidate identity
      // fields (fullName/email/phone/source/piiPurgedAt/createdAt) and
      // internal document fields (extractedText/extractedPageTexts/
      // storageKey/uploadedBy/batchId/processingAttemptCounter/
      // fileSizeBytes/purgedAt) are never selected in the first place, not
      // merely omitted after the fact.
      //
      // currentProcessingRunId itself is selected (never returned) purely
      // to derive the boolean hasCurrentRun below — the candidate detail
      // viewer needs to tell "a current run exists but produced zero
      // results" apart from "no run has ever completed," and a boolean
      // that answers exactly that question is the minimal signal for it,
      // without exposing the run id itself.
      const links = await prisma.candidateProjectLink.findMany({
        where: { projectId: request.project!.id },
        select: {
          candidateId: true,
          anonymizedLabel: true,
          candidate: {
            select: {
              documents: {
                where: { projectId: request.project!.id },
                orderBy: { uploadedAt: "desc" },
                select: {
                  id: true,
                  originalFilename: true,
                  fileType: true,
                  status: true,
                  failureReason: true,
                  uploadedAt: true,
                  currentProcessingRunId: true,
                },
              },
            },
          },
        },
        orderBy: { createdAt: "asc" },
      });

      return links.map((link) => ({
        candidateId: link.candidateId,
        anonymizedLabel: link.anonymizedLabel,
        documents: link.candidate.documents.map((document) => ({
          id: document.id,
          originalFilename: document.originalFilename,
          fileType: document.fileType,
          status: document.status,
          failureReason: document.failureReason,
          uploadedAt: document.uploadedAt,
          hasCurrentRun: document.currentProcessingRunId !== null,
        })),
      }));
    },
  );

  app.post(
    "/projects/:projectId/candidates/:candidateId/documents/:documentId/retry",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const { candidateId, documentId } = request.params as { candidateId: string; documentId: string };
      const project = request.project!;
      const identity = request.session.get("identity")!;

      // Atomic compare-and-swap, not a find-then-update: two concurrent
      // retry requests for the same document must never both flip it to
      // QUEUED and both enqueue a job (that would let two worker jobs run
      // the pipeline for the same CandidateDocument at once — see
      // worker/src/processing-run.ts's stale-RUNNING cleanup, which assumes
      // that can't happen). Postgres serializes two concurrent UPDATEs
      // matching the same row: only the one that still sees status =
      // FAILED_RETRY at the time it acquires the row lock succeeds: the
      // other's WHERE no longer matches after the first commits, so it
      // updates zero rows and falls through to the not-retryable response.
      const { count } = await prisma.candidateDocument.updateMany({
        where: { id: documentId, candidateId, projectId: project.id, status: "FAILED_RETRY" },
        data: { status: "QUEUED", failureReason: null },
      });
      if (count === 0) {
        const document = await prisma.candidateDocument.findFirst({
          where: { id: documentId, candidateId, projectId: project.id },
        });
        if (!document) return reply.code(404).send({ error: "document_not_found" });
        return reply.code(400).send({ error: "not_retryable", status: document.status });
      }

      await queue.enqueue({ candidateDocumentId: documentId, candidateId, projectId: project.id });

      await recordAudit({
        actorId: identity.userId,
        action: "CANDIDATE_DOCUMENT_RETRY_REQUESTED",
        entityType: "CandidateDocument",
        entityId: documentId,
      });

      return { status: "QUEUED" };
    },
  );
}

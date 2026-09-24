import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { redactEvidenceForBlindMode } from "@recruitment-platform/ai-gateway";
import { requireProjectAccess } from "../projects/authorization.js";

/**
 * Phase 5A — Secure read APIs surfacing Requirement Evidence Analysis
 * (Assessment/Evidence) and Career Consistency Analysis results to HR,
 * server-side redacted for Blind Screening. This is the first place any of
 * that AI-generated data leaves the pipeline and reaches an HTTP response —
 * everything below is written on the assumption that whatever it returns is
 * what the browser receives, verbatim.
 *
 * Blind Screening enforcement (approved decision): happens ENTIRELY
 * server-side, before the response is built. The browser never receives
 * fullName/email/phone, never receives originalFilename/sourceDocumentId,
 * never receives aiInteractionId. This module reuses the existing
 * packages/ai-gateway/src/redaction.ts utilities as-is — no second
 * redaction implementation, no schema change, no rewriting of stored rows.
 * The raw Evidence/CandidateConsistencyFinding rows in the database are
 * never touched; only the response objects built here are redacted.
 */
/**
 * Which ProcessingRun(s) are "current" for this candidate in this project:
 * a Candidate may have more than one CandidateDocument (the schema permits
 * it, even though today's upload flow creates exactly one) — this never
 * assumes "the latest document" is the answer. currentProcessingRunId is
 * only ever set, atomically, when a run COMPLETEs (completeProcessingRun(),
 * worker/src/processing-run.ts); a document with no successful run yet has
 * it null and contributes nothing. Every document that DOES have a current
 * run contributes its own current run's id — the union of all of them,
 * never a single arbitrarily-picked document's run. Shared by both
 * endpoints below so Assessment and Career Consistency resolve "current"
 * identically.
 */
async function resolveCurrentRunIds(candidateId: string, projectId: string): Promise<string[]> {
  const currentDocuments = await prisma.candidateDocument.findMany({
    where: { candidateId, projectId, currentProcessingRunId: { not: null } },
    select: { currentProcessingRunId: true },
  });
  return currentDocuments
    .map((d) => d.currentProcessingRunId)
    .filter((id): id is string => id !== null);
}

export async function registerAssessmentRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/projects/:projectId/candidates/:candidateId/assessments",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const { candidateId } = request.params as { candidateId: string; projectId: string };
      const project = request.project!;

      const link = await prisma.candidateProjectLink.findFirst({
        where: { candidateId, projectId: project.id },
      });
      // 404, not a distinguishable "wrong project" error — same
      // don't-confirm-existence rule as requireProjectAccess() itself.
      if (!link) return reply.code(404).send({ error: "candidate_not_found" });

      const currentRunIds = await resolveCurrentRunIds(candidateId, project.id);

      if (currentRunIds.length === 0) {
        return { candidate: { id: candidateId, anonymizedLabel: link.anonymizedLabel }, assessments: [] };
      }

      const experiences = await prisma.candidateExperience.findMany({
        where: { candidateId },
        orderBy: { startDate: "asc" },
      });
      const employerOrder = [...new Set(experiences.map((e) => e.employer))];

      const assessments = await prisma.assessment.findMany({
        where: { candidateId, projectId: project.id, processingRunId: { in: currentRunIds } },
        include: {
          requirement: true,
          requirementVersion: true,
          evidenceLinks: { include: { evidence: true } },
        },
      });

      return {
        candidate: { id: candidateId, anonymizedLabel: link.anonymizedLabel },
        assessments: assessments.map((assessment) => ({
          status: assessment.status,
          requirement: {
            id: assessment.requirement.id,
            description: assessment.requirement.description,
            mandatory: assessment.requirement.mandatory,
            category: assessment.requirement.category,
            hrApprovedWeight: assessment.requirement.hrApprovedWeight,
          },
          requirementVersion: assessment.requirementVersion
            ? {
                id: assessment.requirementVersion.id,
                versionNumber: assessment.requirementVersion.versionNumber,
                evidenceCriteriaSnapshot: assessment.requirementVersion.evidenceCriteriaSnapshot,
              }
            : null,
          evidence: assessment.evidenceLinks.map((link) => ({
            role: link.role,
            // Redacted view-time only — AssessmentEvidence.rationale and
            // Evidence.evidenceText are AI-authored free text from the same
            // analysis call and carry the same identity-leakage risk
            // (direct identifiers, employer names). Every other field below
            // is copied verbatim from the stored row — redaction never
            // touches sourcePage/evidenceStrength/confidence/role.
            rationale: link.rationale ? redactEvidenceForBlindMode(link.rationale, employerOrder) : link.rationale,
            evidenceStrength: link.evidence.evidenceStrength,
            confidence: link.evidence.confidence,
            evidenceType: link.evidence.evidenceType,
            sourcePage: link.evidence.sourcePage,
            evidenceText: link.evidence.evidenceText
              ? redactEvidenceForBlindMode(link.evidence.evidenceText, employerOrder)
              : link.evidence.evidenceText,
            // Blind Screening: no originalFilename, no sourceDocumentId —
            // an opaque label is all the HR-facing response ever carries.
            source: link.evidence.sourceDocumentId ? "Source Document" : null,
          })),
        })),
      };
    },
  );

  app.get(
    "/projects/:projectId/candidates/:candidateId/consistency-findings",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const { candidateId } = request.params as { candidateId: string; projectId: string };
      const project = request.project!;

      const link = await prisma.candidateProjectLink.findFirst({
        where: { candidateId, projectId: project.id },
      });
      if (!link) return reply.code(404).send({ error: "candidate_not_found" });

      const currentRunIds = await resolveCurrentRunIds(candidateId, project.id);

      if (currentRunIds.length === 0) {
        return { candidate: { id: candidateId, anonymizedLabel: link.anonymizedLabel }, findings: [] };
      }

      const experiences = await prisma.candidateExperience.findMany({
        where: { candidateId },
        orderBy: { startDate: "asc" },
      });
      const employerOrder = [...new Set(experiences.map((e) => e.employer))];

      // CandidateConsistencyFinding.processingRunId (Phase 5A follow-up)
      // completes the same traceability model Assessment already has —
      // filtering to the candidate's current run(s) excludes findings from
      // a run that later failed or was superseded by a retry, without ever
      // deleting or reassigning the historical rows themselves.
      const findings = await prisma.candidateConsistencyFinding.findMany({
        where: { candidateId, projectId: project.id, processingRunId: { in: currentRunIds } },
        orderBy: { createdAt: "asc" },
      });

      return {
        candidate: { id: candidateId, anonymizedLabel: link.anonymizedLabel },
        findings: findings.map((finding) => ({
          findingType: finding.findingType,
          severity: finding.severity,
          description: redactEvidenceForBlindMode(finding.description, employerOrder),
          sourcePage: finding.sourcePage,
          evidenceText: finding.evidenceText
            ? redactEvidenceForBlindMode(finding.evidenceText, employerOrder)
            : finding.evidenceText,
          confidence: finding.confidence,
          // Blind Screening: no sourceDocumentId, no aiInteractionId — both
          // stay internal (audit/debugging/traceability), never HR-facing.
          source: finding.sourceDocumentId ? "Source Document" : null,
        })),
      };
    },
  );
}

import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { redactEvidenceForBlindMode } from "@recruitment-platform/ai-gateway";
import {
  computeCandidateCoverage,
  type CoverageEvidenceItem,
  type CoverageRequirementInput,
} from "@recruitment-platform/shared-types";
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
export async function resolveCurrentRunIds(candidateId: string, projectId: string): Promise<string[]> {
  const currentDocuments = await prisma.candidateDocument.findMany({
    where: { candidateId, projectId, currentProcessingRunId: { not: null } },
    select: { currentProcessingRunId: true },
  });
  return currentDocuments
    .map((d) => d.currentProcessingRunId)
    .filter((id): id is string => id !== null);
}

/**
 * Assessment/Evidence Authority (C3, Post-Phase-11 decision; Item 16
 * resolved via Option B). Derived at read time only — never stored on
 * Assessment/Evidence/CandidateConsistencyFinding/CandidateProjectAuthority
 * — by comparing a row's processingRunId against
 * CandidateProjectAuthority.currentProcessingRunId for the row's own
 * (candidateId, projectId). Candidate.currentProfileProcessingRunId
 * (Phase 11) is NOT used here — it remains exclusively the candidate-wide
 * consolidated profile authority, a separate concern from this
 * project-scoped Assessment/Evidence authority. A profile/publication-
 * authority indicator only (Decision 6): it says nothing about
 * EvidenceStrength, Assessment status, or mandatory-gap outcome, all of
 * which remain exactly as computed by the worker.
 */
async function resolveAuthoritativeRunIds(candidateIds: string[], projectId: string): Promise<Map<string, string | null>> {
  const authorities = await prisma.candidateProjectAuthority.findMany({
    where: { candidateId: { in: candidateIds }, projectId },
    select: { candidateId: true, currentProcessingRunId: true },
  });
  return new Map(authorities.map((a) => [a.candidateId, a.currentProcessingRunId]));
}

async function buildEmployerOrder(candidateId: string): Promise<string[]> {
  const experiences = await prisma.candidateExperience.findMany({
    where: { candidateId },
    orderBy: { startDate: "asc" },
  });
  return [...new Set(experiences.map((e) => e.employer))];
}

type EvidenceLinkWithEvidence = {
  role: string;
  rationale: string | null;
  evidence: {
    evidenceStrength: string;
    confidence: string;
    evidenceType: string;
    sourcePage: number | null;
    evidenceText: string | null;
    sourceDocumentId: string | null;
  };
};

/** Shared by the single-candidate assessments endpoint and Candidate Comparison — identical redaction/field rules either way. */
function mapEvidence(link: EvidenceLinkWithEvidence, employerOrder: string[]) {
  return {
    role: link.role,
    rationale: link.rationale ? redactEvidenceForBlindMode(link.rationale, employerOrder) : link.rationale,
    evidenceStrength: link.evidence.evidenceStrength,
    confidence: link.evidence.confidence,
    evidenceType: link.evidence.evidenceType,
    sourcePage: link.evidence.sourcePage,
    evidenceText: link.evidence.evidenceText
      ? redactEvidenceForBlindMode(link.evidence.evidenceText, employerOrder)
      : link.evidence.evidenceText,
    source: link.evidence.sourceDocumentId ? "Source Document" : null,
  };
}

type ConsistencyFindingRow = {
  findingType: string;
  severity: string;
  description: string;
  sourcePage: number | null;
  evidenceText: string | null;
  confidence: string;
  sourceDocumentId: string | null;
  processingRunId: string;
};

/** Shared by the single-candidate consistency-findings endpoint and Candidate Comparison. isAuthoritative is derived by the caller (resolveAuthoritativeRunIds) — never recomputed here from stored state. */
function mapFinding(finding: ConsistencyFindingRow, employerOrder: string[], isAuthoritative: boolean) {
  return {
    findingType: finding.findingType,
    severity: finding.severity,
    description: redactEvidenceForBlindMode(finding.description, employerOrder),
    sourcePage: finding.sourcePage,
    evidenceText: finding.evidenceText ? redactEvidenceForBlindMode(finding.evidenceText, employerOrder) : finding.evidenceText,
    confidence: finding.confidence,
    source: finding.sourceDocumentId ? "Source Document" : null,
    isAuthoritative,
  };
}

const MIN_COMPARISON_CANDIDATES = 2;
const MAX_COMPARISON_CANDIDATES = 5;

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

      const employerOrder = await buildEmployerOrder(candidateId);
      const authoritativeRunIdByCandidateId = await resolveAuthoritativeRunIds([candidateId], project.id);
      const authoritativeRunId = authoritativeRunIdByCandidateId.get(candidateId) ?? null;

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
          // Phase 6: the HR Decision UI's "override this assessment" picker
          // needs a stable handle to POST back as decisions.assessmentId —
          // this is the Assessment's own id, not a candidate identity field
          // or an internal document/run reference, so it's safe to expose
          // (the decisions POST route re-validates it belongs to this
          // candidate's current run regardless of what the client sends).
          id: assessment.id,
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
          evidence: assessment.evidenceLinks.map((link) => mapEvidence(link, employerOrder)),
          isAuthoritative: assessment.processingRunId === authoritativeRunId,
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

      const employerOrder = await buildEmployerOrder(candidateId);
      const authoritativeRunIdByCandidateId = await resolveAuthoritativeRunIds([candidateId], project.id);
      const authoritativeRunId = authoritativeRunIdByCandidateId.get(candidateId) ?? null;

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
        findings: findings.map((finding) =>
          mapFinding(finding, employerOrder, finding.processingRunId === authoritativeRunId),
        ),
      };
    },
  );

  registerCandidateComparisonRoute(app);
}

/**
 * Phase 5 completion — Candidate Comparison. Deterministic, read-only,
 * evidence-first: derived entirely from existing Assessment/Evidence/
 * CandidateConsistencyFinding rows, on every request — no AI call, no
 * persisted snapshot (the pre-existing CandidateComparison model and
 * CANDIDATE_COMPARISON AI task/comparisonText are deliberately NOT used
 * here — left as unused legacy design, not deleted or modified).
 *
 * Phase 9 — each candidate now also carries an `evidenceCoverage` object
 * (packages/shared-types/src/evidence-coverage.ts, Model C, computed here
 * from the same Assessment/Evidence rows, no extra query). This is
 * explicitly NOT a score: no numeric value is ever assigned to
 * EvidenceStrength, EvidenceConfidence never affects it, and no rank or
 * "best/recommended candidate" is ever computed. Candidates are still
 * always returned in the exact order the caller requested them (selection
 * order) — coverage is displayed per candidate, never used to reorder,
 * sort, or filter the response.
 */
function registerCandidateComparisonRoute(app: FastifyInstance): void {
  app.post(
    "/projects/:projectId/candidates/compare",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const project = request.project!;
      const body = request.body as { candidateIds?: unknown };

      if (!Array.isArray(body.candidateIds) || body.candidateIds.some((id) => typeof id !== "string")) {
        return reply.code(400).send({ error: "invalid_candidate_ids" });
      }
      // Preserve caller order (selection order) but de-duplicate — a
      // repeated id in the request must not silently double-count toward
      // the 2-5 range or appear twice as a column.
      const candidateIds = [...new Set(body.candidateIds as string[])];
      if (candidateIds.length < MIN_COMPARISON_CANDIDATES || candidateIds.length > MAX_COMPARISON_CANDIDATES) {
        return reply.code(400).send({ error: "invalid_candidate_count" });
      }

      // All-or-nothing membership check: if ANY requested candidate is not
      // linked to this project, the entire request is rejected — no
      // partial processing, and no information about which id(s) were
      // invalid is returned (never confirms or denies existence of a
      // specific candidate outside this project, same principle as
      // requireProjectAccess() itself).
      const links = await prisma.candidateProjectLink.findMany({
        where: { projectId: project.id, candidateId: { in: candidateIds } },
        select: { candidateId: true, anonymizedLabel: true },
      });
      if (links.length !== candidateIds.length) {
        return reply.code(400).send({ error: "invalid_candidates" });
      }
      const labelByCandidateId = new Map(links.map((l) => [l.candidateId, l.anonymizedLabel]));

      // Document status per candidate — independent per candidate, exactly
      // the same fields/precedence the single-candidate viewer already
      // uses (Phase 5C's hasCurrentRun, never the raw run id).
      const documents = await prisma.candidateDocument.findMany({
        where: { candidateId: { in: candidateIds }, projectId: project.id },
        select: { candidateId: true, status: true, currentProcessingRunId: true },
      });
      const documentsByCandidateId = new Map<string, typeof documents>();
      for (const candidateId of candidateIds) documentsByCandidateId.set(candidateId, []);
      for (const doc of documents) documentsByCandidateId.get(doc.candidateId)?.push(doc);

      // Every candidate's own current run(s), independently — one
      // candidate's processing state can never affect another's, since
      // each candidate's runIds are resolved and used in isolation here.
      const currentRunIdsByCandidateId = new Map<string, string[]>();
      for (const candidateId of candidateIds) {
        const docs = documentsByCandidateId.get(candidateId) ?? [];
        currentRunIdsByCandidateId.set(
          candidateId,
          docs.map((d) => d.currentProcessingRunId).filter((id): id is string => id !== null),
        );
      }
      const allCurrentRunIds = [...currentRunIdsByCandidateId.values()].flat();
      const authoritativeRunIdByCandidateId = await resolveAuthoritativeRunIds(candidateIds, project.id);

      const employerOrderByCandidateId = new Map<string, string[]>();
      for (const candidateId of candidateIds) {
        employerOrderByCandidateId.set(candidateId, await buildEmployerOrder(candidateId));
      }

      // A given processingRunId belongs to exactly one CandidateDocument,
      // and therefore exactly one candidate — filtering by
      // `processingRunId: { in: allCurrentRunIds }` cannot leak one
      // candidate's Assessment/Finding rows into another's, even though
      // the query spans all requested candidates in one round trip.
      const assessments =
        allCurrentRunIds.length === 0
          ? []
          : await prisma.assessment.findMany({
              where: { candidateId: { in: candidateIds }, projectId: project.id, processingRunId: { in: allCurrentRunIds } },
              include: {
                requirement: true,
                requirementVersion: true,
                evidenceLinks: { include: { evidence: true } },
              },
            });

      const findings =
        allCurrentRunIds.length === 0
          ? []
          : await prisma.candidateConsistencyFinding.findMany({
              where: { candidateId: { in: candidateIds }, projectId: project.id, processingRunId: { in: allCurrentRunIds } },
              orderBy: { createdAt: "asc" },
            });

      // Group by (requirementId, requirementVersionId) — NEVER by
      // requirementId alone. Two candidates assessed against different
      // versions of "the same" requirement must never be merged into one
      // row; each version gets its own row, explicitly labeled, so a
      // reader is never shown a side-by-side comparison of two candidates
      // evaluated against different standards without being told so.
      const rowKey = (requirementId: string, requirementVersionId: string | null) =>
        `${requirementId}::${requirementVersionId ?? "none"}`;
      const rows = new Map<
        string,
        {
          requirementId: string;
          requirementVersionId: string | null;
          versionNumber: number | null;
          description: string;
          mandatory: boolean;
          category: string;
          hrApprovedWeight: string | null;
          // Phase 12 (C3) — an ARRAY per candidate, not a single nullable
          // value. Under the hybrid/union model (Phase 4A's own
          // resolveCurrentRunIds, unchanged), a candidate can legitimately
          // have more than one Assessment for the same
          // (requirementId, requirementVersionId) when more than one of
          // their documents has its own current run — e.g. one
          // authoritative (Phase 11) and one not. Previously this was a
          // single object silently overwritten by whichever row the DB
          // returned last; every result is now preserved, each tagged
          // with its own isAuthoritative derived flag, and none is
          // arbitrarily dropped or merged.
          resultsByCandidate: Record<string, unknown[]>;
        }
      >();

      for (const assessment of assessments) {
        const key = rowKey(assessment.requirementId, assessment.requirementVersionId);
        if (!rows.has(key)) {
          rows.set(key, {
            requirementId: assessment.requirementId,
            requirementVersionId: assessment.requirementVersionId,
            versionNumber: assessment.requirementVersion?.versionNumber ?? null,
            description: assessment.requirement.description,
            mandatory: assessment.requirement.mandatory,
            category: assessment.requirement.category,
            hrApprovedWeight: assessment.requirement.hrApprovedWeight ? String(assessment.requirement.hrApprovedWeight) : null,
            resultsByCandidate: Object.fromEntries(candidateIds.map((id) => [id, []])),
          });
        }
        const row = rows.get(key)!;
        const employerOrder = employerOrderByCandidateId.get(assessment.candidateId) ?? [];
        const authoritativeRunId = authoritativeRunIdByCandidateId.get(assessment.candidateId) ?? null;
        row.resultsByCandidate[assessment.candidateId].push({
          status: assessment.status,
          evidence: assessment.evidenceLinks.map((link) => mapEvidence(link, employerOrder)),
          isAuthoritative: assessment.processingRunId === authoritativeRunId,
        });
      }

      // Deterministic row order: by requirement description, then version
      // number — never by any candidate's outcome (status/strength/etc).
      const requirementRows = [...rows.values()].sort((a, b) => {
        const byDescription = a.description.localeCompare(b.description);
        if (byDescription !== 0) return byDescription;
        return (a.versionNumber ?? 0) - (b.versionNumber ?? 0);
      });

      const consistencyFindingsByCandidate: Record<string, unknown[]> = Object.fromEntries(
        candidateIds.map((id) => [id, []]),
      );
      for (const finding of findings) {
        const employerOrder = employerOrderByCandidateId.get(finding.candidateId) ?? [];
        const authoritativeRunId = authoritativeRunIdByCandidateId.get(finding.candidateId) ?? null;
        consistencyFindingsByCandidate[finding.candidateId].push(
          mapFinding(finding, employerOrder, finding.processingRunId === authoritativeRunId),
        );
      }

      // Phase 9 — Evidence Coverage, per candidate. Built from the same
      // `assessments` rows already fetched above — no extra DB round trip.
      const assessmentsByCandidateId = new Map<string, typeof assessments>();
      for (const candidateId of candidateIds) assessmentsByCandidateId.set(candidateId, []);
      for (const assessment of assessments) assessmentsByCandidateId.get(assessment.candidateId)?.push(assessment);

      const evidenceCoverageByCandidateId = new Map<string, ReturnType<typeof computeCandidateCoverage> | null>();
      for (const candidateId of candidateIds) {
        const hasCurrentRun = (currentRunIdsByCandidateId.get(candidateId) ?? []).length > 0;
        if (!hasCurrentRun) {
          // No completed processing run yet — coverage is not computable,
          // and must never be shown as 0% (that would misrepresent "not
          // yet processed" as "no evidence found").
          evidenceCoverageByCandidateId.set(candidateId, null);
          continue;
        }
        const requirementInputs: CoverageRequirementInput[] = (assessmentsByCandidateId.get(candidateId) ?? []).map(
          (assessment): CoverageRequirementInput => ({
            requirementId: assessment.requirementId,
            mandatory: assessment.requirement.mandatory,
            // The weight in effect when THIS assessment was made — the
            // pinned, immutable JobRequirementVersion's own
            // hrApprovedWeight, never the requirement's current weight
            // (which may have changed since). null (no version pinned)
            // excludes this requirement from the coverage calculation.
            weight: assessment.requirementVersion ? Number(assessment.requirementVersion.hrApprovedWeight) : null,
            evidence: assessment.evidenceLinks.map(
              (link): CoverageEvidenceItem => ({
                role: link.role as CoverageEvidenceItem["role"],
                strength: link.evidence.evidenceStrength as CoverageEvidenceItem["strength"],
                confidence: link.evidence.confidence as CoverageEvidenceItem["confidence"],
              }),
            ),
          }),
        );
        evidenceCoverageByCandidateId.set(candidateId, computeCandidateCoverage(requirementInputs));
      }

      // Per-candidate processing state — computed independently for each
      // candidate, identical precedence rules to the single-candidate
      // viewer (Phase 5B/5C): (1) current results always shown regardless
      // of a sibling document's FAILED_RETRY; (2) a current run with zero
      // results is never mistaken for "no run"; (3) FAILED_RETRY only
      // means "failed" when no current run exists; (4) QUEUED/PROCESSING
      // always shows "processing," independent of every other candidate.
      const candidates = candidateIds.map((candidateId) => {
        const docs = documentsByCandidateId.get(candidateId) ?? [];
        const isProcessing = docs.some((d) => d.status === "QUEUED" || d.status === "PROCESSING");
        const hasCurrentRun = (currentRunIdsByCandidateId.get(candidateId) ?? []).length > 0;
        const hasResults =
          requirementRows.some((row) => row.resultsByCandidate[candidateId].length > 0) ||
          consistencyFindingsByCandidate[candidateId].length > 0;
        const isFailed = !hasResults && !isProcessing && !hasCurrentRun && docs.some((d) => d.status === "FAILED_RETRY");
        return {
          candidateId,
          anonymizedLabel: labelByCandidateId.get(candidateId)!,
          hasCurrentRun,
          isProcessing,
          isFailed,
          evidenceCoverage: evidenceCoverageByCandidateId.get(candidateId) ?? null,
        };
      });

      return { candidates, requirementRows, consistencyFindingsByCandidate };
    },
  );
}

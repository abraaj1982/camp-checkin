import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { requireProjectAccess } from "../projects/authorization.js";
import { resolveCurrentRunIds } from "../assessments/routes.js";
import { recordAudit } from "../../lib/audit.js";

/**
 * HR decisions never touch the Assessment row (architecture doc, Section
 * 25/12 of the master instruction: "never silently modify historical AI
 * assessments"). An override is a separate HrOverride row pointing back at
 * the original, untouched assessmentId. A decision is a human action taken
 * in response to evidence already presented elsewhere (Evidence Viewer /
 * Candidate Comparison) — this module never computes, infers, or suggests
 * a decision; it only records the one HR made.
 *
 * Nested under /projects/:projectId (Phase 2 hardening, Section 3) rather
 * than the old bare /candidates/:candidateId/decisions — a decision is
 * always made in the context of one project (HrDecision.projectId is
 * required), so it gets the same requireProjectAccess gate as every other
 * project-scoped route, including the HR_ADMIN/SYSTEM_ADMIN bypass.
 *
 * Phase 6 (HR Decision UI) hardening: candidate/project membership is now
 * verified the same way every other Phase 5 candidate route does it (404,
 * not a distinguishable error, if the candidateId isn't linked to this
 * project) — closing a gap where the original Phase 2 route trusted the
 * candidateId path param without checking it belonged to the project at
 * all. Responses are now explicit DTOs, never a raw Prisma row.
 */

type DecisionType = "SHORTLIST" | "HOLD" | "REJECT" | "INTERVIEW";

function mapOverride(
  override: { assessmentId: string; overridden: boolean; hrNote: string | null } | null,
) {
  if (!override) return null;
  return {
    assessmentId: override.assessmentId,
    overridden: override.overridden,
    hrNote: override.hrNote,
  };
}

export async function registerDecisionRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/projects/:projectId/candidates/:candidateId/decisions",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const { candidateId } = request.params as { candidateId: string; projectId: string };
      const project = request.project!;
      const body = request.body as {
        decision: DecisionType;
        notes?: string;
        // The assessment HR is reacting to, if this decision overrides one.
        assessmentId?: string;
      };
      const identity = request.session.get("identity")!;

      // Same not-confirm-existence rule as requireProjectAccess() itself:
      // a candidateId that isn't linked to this project gets 404, not a
      // distinguishable "wrong project" error.
      const link = await prisma.candidateProjectLink.findFirst({
        where: { candidateId, projectId: project.id },
      });
      if (!link) return reply.code(404).send({ error: "candidate_not_found" });

      let overrideAssessment: { id: string; status: string } | null = null;
      if (body.assessmentId) {
        // The override picker only ever offers the candidate's CURRENT-run
        // assessments (Decision 3) — re-checked here, server-side, rather
        // than trusted from the client: an assessment belonging to this
        // candidate/project but from a superseded (non-current) run is
        // rejected, exactly like a wrong-candidate or wrong-project one.
        const currentRunIds = await resolveCurrentRunIds(candidateId, project.id);
        const assessment =
          currentRunIds.length === 0
            ? null
            : await prisma.assessment.findFirst({
                where: {
                  id: body.assessmentId,
                  candidateId,
                  projectId: project.id,
                  processingRunId: { in: currentRunIds },
                },
                select: { id: true, status: true },
              });
        if (!assessment) return reply.code(404).send({ error: "assessment_not_found" });
        overrideAssessment = assessment;
      }

      const decision = await prisma.hrDecision.create({
        data: {
          candidateId,
          projectId: project.id,
          decision: body.decision,
          decidedBy: identity.userId,
          notes: body.notes,
        },
        select: { id: true, decision: true, notes: true, decidedAt: true },
      });

      let override: { assessmentId: string; overridden: boolean; hrNote: string | null } | null = null;
      if (overrideAssessment) {
        const overridden =
          (overrideAssessment.status === "MANDATORY_GAP" || overrideAssessment.status === "REVIEW_REQUIRED") &&
          (body.decision === "SHORTLIST" || body.decision === "INTERVIEW");

        override = await prisma.hrOverride.create({
          data: {
            decisionId: decision.id,
            assessmentId: overrideAssessment.id,
            overridden,
            hrNote: body.notes,
          },
          select: { assessmentId: true, overridden: true, hrNote: true },
        });
      }

      await recordAudit({
        actorId: identity.userId,
        action: "HR_DECISION_RECORDED",
        entityType: "Candidate",
        entityId: candidateId,
        after: { decision: body.decision, assessmentId: body.assessmentId },
      });

      return {
        id: decision.id,
        decision: decision.decision,
        notes: decision.notes,
        decidedAt: decision.decidedAt,
        override: mapOverride(override),
      };
    },
  );

  app.get(
    "/projects/:projectId/candidates/:candidateId/decisions",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const { candidateId } = request.params as { candidateId: string; projectId: string };
      const project = request.project!;

      const link = await prisma.candidateProjectLink.findFirst({
        where: { candidateId, projectId: project.id },
      });
      if (!link) return reply.code(404).send({ error: "candidate_not_found" });

      // Explicit select + explicit response mapping (Phase 5C/6 convention)
      // — never `include` + raw-return. decidedBy resolves only to the HR
      // user's own name, never a candidate identity field: Blind Screening
      // governs candidate-derived data, not the HR user's own identity.
      const decisions = await prisma.hrDecision.findMany({
        where: { candidateId, projectId: project.id },
        orderBy: { decidedAt: "desc" },
        select: {
          id: true,
          decision: true,
          notes: true,
          decidedAt: true,
          decider: { select: { name: true } },
          override: { select: { assessmentId: true, overridden: true, hrNote: true } },
        },
      });

      return {
        decisions: decisions.map((d) => ({
          id: d.id,
          decision: d.decision,
          notes: d.notes,
          decidedAt: d.decidedAt,
          decidedByName: d.decider.name,
          override: mapOverride(d.override),
        })),
      };
    },
  );
}

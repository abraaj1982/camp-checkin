import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { requireProjectAccess } from "../projects/authorization.js";
import { recordAudit } from "../../lib/audit.js";

/**
 * HR decisions never touch the Assessment row (architecture doc, Section
 * 25/12 of the master instruction: "never silently modify historical AI
 * assessments"). An override is a separate HrOverride row pointing back at
 * the original, untouched assessmentId.
 *
 * Nested under /projects/:projectId (Phase 2 hardening, Section 3) rather
 * than the old bare /candidates/:candidateId/decisions — a decision is
 * always made in the context of one project (HrDecision.projectId is
 * required), so it gets the same requireProjectAccess gate as every other
 * project-scoped route, including the HR_ADMIN/SYSTEM_ADMIN bypass. This
 * does not add any Phase 6 functionality — the route body/behavior is
 * unchanged, only where projectId comes from and how access is checked.
 */
export async function registerDecisionRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/projects/:projectId/candidates/:candidateId/decisions",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const { candidateId } = request.params as { candidateId: string; projectId: string };
      const project = request.project!;
      const body = request.body as {
        decision: "SHORTLIST" | "HOLD" | "REJECT" | "INTERVIEW";
        notes?: string;
        // The assessment HR is reacting to, if this decision overrides one.
        assessmentId?: string;
      };
      const identity = request.session.get("identity")!;

      const decision = await prisma.hrDecision.create({
        data: {
          candidateId,
          projectId: project.id,
          decision: body.decision,
          decidedBy: identity.userId,
          notes: body.notes,
        },
      });

      if (body.assessmentId) {
        const assessment = await prisma.assessment.findUnique({ where: { id: body.assessmentId } });
        if (!assessment) return reply.code(404).send({ error: "assessment_not_found" });
        if (assessment.projectId !== project.id) {
          return reply.code(400).send({ error: "assessment_not_in_project" });
        }

        const overridden =
          (assessment.status === "MANDATORY_GAP" || assessment.status === "REVIEW_REQUIRED") &&
          (body.decision === "SHORTLIST" || body.decision === "INTERVIEW");

        await prisma.hrOverride.create({
          data: {
            decisionId: decision.id,
            assessmentId: assessment.id,
            overridden,
            hrNote: body.notes,
          },
        });
      }

      await recordAudit({
        actorId: identity.userId,
        action: "HR_DECISION_RECORDED",
        entityType: "Candidate",
        entityId: candidateId,
        after: { decision: body.decision, assessmentId: body.assessmentId },
      });

      return decision;
    },
  );
}

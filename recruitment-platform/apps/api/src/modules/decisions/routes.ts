import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { requireAuth } from "../auth/rbac.js";
import { recordAudit } from "../../lib/audit.js";

/**
 * HR decisions never touch the Assessment row (architecture doc, Section
 * 25/12 of the master instruction: "never silently modify historical AI
 * assessments"). An override is a separate HrOverride row pointing back at
 * the original, untouched assessmentId.
 */
export async function registerDecisionRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/candidates/:candidateId/decisions",
    { preHandler: requireAuth() },
    async (request, reply) => {
      const { candidateId } = request.params as { candidateId: string };
      const body = request.body as {
        projectId: string;
        decision: "SHORTLIST" | "HOLD" | "REJECT" | "INTERVIEW";
        notes?: string;
        // The assessment HR is reacting to, if this decision overrides one.
        assessmentId?: string;
      };
      const identity = request.session.get("identity")!;

      const decision = await prisma.hrDecision.create({
        data: {
          candidateId,
          projectId: body.projectId,
          decision: body.decision,
          decidedBy: identity.userId,
          notes: body.notes,
        },
      });

      if (body.assessmentId) {
        const assessment = await prisma.assessment.findUnique({ where: { id: body.assessmentId } });
        if (!assessment) return reply.code(404).send({ error: "assessment_not_found" });

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

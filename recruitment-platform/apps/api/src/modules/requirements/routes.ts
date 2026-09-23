import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { AiGateway, AiValidationError } from "@recruitment-platform/ai-gateway";
import { requireAuth } from "../auth/rbac.js";
import { recordAudit } from "../../lib/audit.js";

/**
 * Demonstrates the end-to-end pattern every AI-backed route follows:
 * gateway call -> schema-validated output -> deterministic persistence ->
 * audit log. AiValidationError is caught and surfaced as a retryable
 * failure, never silently swallowed into a stored (and wrong) result
 * (architecture doc, Section 36).
 */
export async function registerRequirementRoutes(
  app: FastifyInstance,
  gateway: AiGateway,
): Promise<void> {
  app.post(
    "/projects/:projectId/requirements/interpret",
    { preHandler: requireAuth() },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const { rawText } = request.body as { rawText: string };
      const identity = request.session.get("identity")!;

      const project = await prisma.recruitmentProject.findUnique({ where: { id: projectId } });
      if (!project) return reply.code(404).send({ error: "project_not_found" });

      try {
        const output = await gateway.runTask({
          taskType: "REQUIREMENT_INTERPRETATION",
          systemPrompt:
            "You interpret raw HR job-requirement text into structured requirements. " +
            "Never invent a requirement the text does not support. Use the OTHER category " +
            "sparingly, only when no listed category fits.",
          userPrompt: rawText,
          inputRef: `project:${projectId}`,
        });

        const created = await prisma.$transaction(
          output.requirements.map((r) =>
            prisma.jobRequirement.create({
              data: {
                projectId,
                category: r.category,
                description: r.description,
                mandatory: r.mandatory,
                evidenceCriteria: r.evidenceCriteria,
                status: "DRAFT",
              },
            }),
          ),
        );

        await recordAudit({
          actorId: identity.userId,
          action: "REQUIREMENTS_INTERPRETED",
          entityType: "RecruitmentProject",
          entityId: projectId,
          after: { count: created.length },
        });

        return { requirements: created };
      } catch (err) {
        if (err instanceof AiValidationError) {
          return reply.code(502).send({ error: "ai_validation_failed", taskType: err.taskType });
        }
        throw err;
      }
    },
  );

  app.post(
    "/projects/:projectId/requirements/weighting-recommendation",
    { preHandler: requireAuth() },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const requirements = await prisma.jobRequirement.findMany({ where: { projectId } });
      if (requirements.length === 0) {
        return reply.code(400).send({ error: "no_requirements" });
      }

      try {
        const output = await gateway.runTask({
          taskType: "WEIGHTING_RECOMMENDATION",
          systemPrompt:
            "You propose relative weights (summing to 100) for a list of job requirements, " +
            "with a short rationale per requirement. Mandatory requirements generally warrant " +
            "higher weight, but defer to the wording and emphasis in each requirement.",
          userPrompt: JSON.stringify(
            requirements.map((r) => ({ id: r.id, description: r.description, mandatory: r.mandatory })),
          ),
          inputRef: `project:${projectId}`,
        });

        await prisma.$transaction(
          output.weights.map((w) =>
            prisma.jobRequirement.update({
              where: { id: w.requirementId },
              data: { aiSuggestedWeight: w.suggestedWeight, notes: w.rationale },
            }),
          ),
        );

        return { weights: output.weights };
      } catch (err) {
        if (err instanceof AiValidationError) {
          return reply.code(502).send({ error: "ai_validation_failed", taskType: err.taskType });
        }
        throw err;
      }
    },
  );

  // Deterministic weight-total validation (architecture doc, Section 9) —
  // never delegated to the LLM.
  app.post(
    "/projects/:projectId/requirements/approve-weights",
    { preHandler: requireAuth() },
    async (request, reply) => {
      const { projectId } = request.params as { projectId: string };
      const body = request.body as { weights: { requirementId: string; weight: number }[] };
      const identity = request.session.get("identity")!;

      const total = body.weights.reduce((sum, w) => sum + w.weight, 0);
      if (Math.abs(total - 100) > 0.01) {
        return reply.code(400).send({ error: "weights_must_total_100", total });
      }

      await prisma.$transaction(
        body.weights.flatMap((w) => [
          prisma.jobRequirement.update({
            where: { id: w.requirementId },
            data: { hrApprovedWeight: w.weight, status: "APPROVED" },
          }),
          prisma.requirementWeightApproval.create({
            data: { requirementId: w.requirementId, approvedBy: identity.userId, newWeight: w.weight },
          }),
        ]),
      );

      await recordAudit({
        actorId: identity.userId,
        action: "WEIGHTS_APPROVED",
        entityType: "RecruitmentProject",
        entityId: projectId,
        after: body.weights,
      });

      return { status: "approved" };
    },
  );
}

import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { AiGateway, AiValidationError } from "@recruitment-platform/ai-gateway";
import {
  buildRequirementVersionSnapshot,
  statusAfterEdit,
  validateWeightTotal,
  weightChangeRequiresNote,
} from "@recruitment-platform/shared-types";
import { requireProjectAccess } from "../projects/authorization.js";
import { recordAudit } from "../../lib/audit.js";

/**
 * Requirements + AI interpretation + weighting + approval, all project-
 * scoped and gated by requireProjectAccess (any assigned member may work
 * requirements — requireProjectManage is reserved for project-level admin
 * actions like archiving or membership changes, per Phase 2 Section 1).
 */
export async function registerRequirementRoutes(
  app: FastifyInstance,
  gateway: AiGateway,
): Promise<void> {
  app.post(
    "/projects/:projectId/requirements",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const body = request.body as {
        category: string;
        customCategoryLabel?: string;
        description: string;
        mandatory: boolean;
        priority?: string;
        evidenceCriteria?: string;
        hrNotes?: string;
      };
      const identity = request.session.get("identity")!;
      const project = request.project!;

      if (project.status === "ARCHIVED") {
        return reply.code(400).send({ error: "project_archived" });
      }
      if (body.category === "OTHER" && !body.customCategoryLabel) {
        return reply.code(400).send({ error: "custom_category_label_required" });
      }

      const requirement = await prisma.jobRequirement.create({
        data: {
          projectId: project.id,
          category: body.category as never,
          customCategoryLabel: body.customCategoryLabel,
          description: body.description,
          mandatory: body.mandatory,
          priority: (body.priority as never) ?? "MEDIUM",
          evidenceCriteria: body.evidenceCriteria,
          hrNotes: body.hrNotes,
          status: "DRAFT",
        },
      });

      await recordAudit({
        actorId: identity.userId,
        action: "REQUIREMENT_CREATED",
        entityType: "JobRequirement",
        entityId: requirement.id,
        after: requirement,
      });

      return requirement;
    },
  );

  app.get(
    "/projects/:projectId/requirements",
    { preHandler: requireProjectAccess() },
    async (request) => {
      return prisma.jobRequirement.findMany({
        where: { projectId: request.project!.id, status: { not: "ARCHIVED" } },
        include: { semanticConcepts: true, criteria: { orderBy: { sortOrder: "asc" } } },
        orderBy: { createdAt: "asc" },
      });
    },
  );

  app.patch(
    "/projects/:projectId/requirements/:requirementId",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const { requirementId } = request.params as { requirementId: string };
      const body = request.body as Partial<{
        category: string;
        customCategoryLabel: string | null;
        description: string;
        mandatory: boolean;
        priority: string;
        evidenceCriteria: string;
        hrNotes: string;
      }>;
      const identity = request.session.get("identity")!;
      const project = request.project!;

      const existing = await prisma.jobRequirement.findFirst({
        where: { id: requirementId, projectId: project.id },
      });
      if (!existing) return reply.code(404).send({ error: "requirement_not_found" });
      if (existing.status === "ARCHIVED") {
        return reply.code(400).send({ error: "requirement_archived" });
      }
      if (body.category === "OTHER" && !(body.customCategoryLabel ?? existing.customCategoryLabel)) {
        return reply.code(400).send({ error: "custom_category_label_required" });
      }

      // Editing an approved requirement never overwrites the approved
      // JobRequirementVersion snapshot — it only moves the live draft to
      // CHANGED, pending re-approval (Phase 2, Section 10).
      const nextStatus = statusAfterEdit(existing.currentVersionNumber);

      const updated = await prisma.jobRequirement.update({
        where: { id: requirementId },
        data: {
          ...body,
          category: body.category as never,
          priority: body.priority as never,
          status: nextStatus,
        },
      });

      await recordAudit({
        actorId: identity.userId,
        action: "REQUIREMENT_EDITED",
        entityType: "JobRequirement",
        entityId: requirementId,
        before: existing,
        after: updated,
      });

      return updated;
    },
  );

  app.delete(
    "/projects/:projectId/requirements/:requirementId",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const { requirementId } = request.params as { requirementId: string };
      const identity = request.session.get("identity")!;
      const project = request.project!;

      const existing = await prisma.jobRequirement.findFirst({
        where: { id: requirementId, projectId: project.id },
      });
      if (!existing) return reply.code(404).send({ error: "requirement_not_found" });

      const archived = await prisma.jobRequirement.update({
        where: { id: requirementId },
        data: { status: "ARCHIVED" },
      });

      await recordAudit({
        actorId: identity.userId,
        action: "REQUIREMENT_ARCHIVED",
        entityType: "JobRequirement",
        entityId: requirementId,
        before: { status: existing.status },
        after: { status: archived.status },
      });

      return archived;
    },
  );

  // Semantic interpretation + evidence-criteria generation (Phase 2,
  // Sections 4 & 5) — one batched AI call for every non-archived
  // requirement in the project, not one call per requirement.
  app.post(
    "/projects/:projectId/requirements/interpret",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const identity = request.session.get("identity")!;
      const project = request.project!;

      const requirements = await prisma.jobRequirement.findMany({
        where: { projectId: project.id, status: { not: "ARCHIVED" } },
      });
      if (requirements.length === 0) {
        return reply.code(400).send({ error: "no_requirements" });
      }

      try {
        const output = await gateway.runTask({
          taskType: "REQUIREMENT_INTERPRETATION",
          systemPrompt:
            "For each job requirement below, produce a plain-language interpretation, a list of " +
            "semantically related concepts with a relevance tier (DIRECT/RELEVANT/PARTIALLY_RELEVANT/" +
            "NOT_RELEVANT) and a stated rationale for each, and an ordered list of concrete evidence " +
            "criteria — what convincing evidence of this requirement would look like inside a CV. " +
            "Do not treat every adjacent HR experience as equivalent; distinguish relevance tiers " +
            "honestly, including NOT_RELEVANT where a superficially similar concept does not actually apply.",
          userPrompt: JSON.stringify(
            requirements.map((r) => ({
              requirementId: r.id,
              description: r.description,
              category: r.category,
              mandatory: r.mandatory,
            })),
          ),
          inputRef: `project:${project.id}`,
        });

        await prisma.$transaction(async (tx) => {
          for (const interpretation of output.interpretations) {
            await tx.requirementSemanticConcept.deleteMany({
              where: { requirementId: interpretation.requirementId },
            });
            await tx.requirementEvidenceCriterion.deleteMany({
              where: { requirementId: interpretation.requirementId },
            });
            await tx.jobRequirement.update({
              where: { id: interpretation.requirementId },
              data: {
                aiInterpretationSummary: interpretation.interpretationSummary,
                status: "AI_ANALYZED",
                semanticConcepts: {
                  create: interpretation.semanticConcepts.map((c) => ({
                    concept: c.concept,
                    relevance: c.relevance,
                    rationale: c.rationale,
                  })),
                },
                criteria: {
                  create: interpretation.evidenceCriteria.map((description, index) => ({
                    description,
                    sortOrder: index,
                  })),
                },
              },
            });
          }
        });

        await recordAudit({
          actorId: identity.userId,
          action: "REQUIREMENTS_AI_INTERPRETED",
          entityType: "RecruitmentProject",
          entityId: project.id,
          after: { count: output.interpretations.length },
        });

        return { interpretations: output.interpretations };
      } catch (err) {
        if (err instanceof AiValidationError) {
          return reply.code(502).send({ error: "ai_validation_failed", taskType: err.taskType });
        }
        throw err;
      }
    },
  );

  // AI proposes; nothing here writes hrApprovedWeight (Section 6: "Do NOT
  // let AI produce the final score").
  app.post(
    "/projects/:projectId/requirements/weighting-recommendation",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const identity = request.session.get("identity")!;
      const project = request.project!;

      const requirements = await prisma.jobRequirement.findMany({
        where: { projectId: project.id, status: { not: "ARCHIVED" } },
        include: { criteria: true },
      });
      if (requirements.length === 0) {
        return reply.code(400).send({ error: "no_requirements" });
      }

      try {
        const output = await gateway.runTask({
          taskType: "WEIGHTING_RECOMMENDATION",
          systemPrompt:
            "Propose relative weights (summing to 100) for these job requirements, considering " +
            "mandatory vs. preferred status, business/role criticality, impact on successful " +
            "performance, how much evidence for it is realistically findable in a CV, requirement " +
            "specificity, and how requirements relate to each other. State a short rationale citing " +
            "these factors for each weight — this is a recommendation only; a human approves the final number.",
          userPrompt: JSON.stringify(
            requirements.map((r) => ({
              id: r.id,
              description: r.description,
              mandatory: r.mandatory,
              priority: r.priority,
              evidenceCriteria: r.criteria.map((c) => c.description),
            })),
          ),
          inputRef: `project:${project.id}`,
        });

        await prisma.$transaction(
          output.weights.map((w) =>
            prisma.jobRequirement.update({
              where: { id: w.requirementId },
              data: { aiSuggestedWeight: w.suggestedWeight, hrNotes: w.rationale, status: "HR_REVIEW" },
            }),
          ),
        );

        await recordAudit({
          actorId: identity.userId,
          action: "REQUIREMENTS_AI_WEIGHTED",
          entityType: "RecruitmentProject",
          entityId: project.id,
          after: output.weights,
        });

        return { weights: output.weights };
      } catch (err) {
        if (err instanceof AiValidationError) {
          return reply.code(502).send({ error: "ai_validation_failed", taskType: err.taskType });
        }
        throw err;
      }
    },
  );

  // HR modifies one requirement's weight ahead of final approval. A note is
  // required only when the value diverges from the AI suggestion (Section 7).
  app.patch(
    "/projects/:projectId/requirements/:requirementId/weight",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const { requirementId } = request.params as { requirementId: string };
      const body = request.body as { weight: number; hrNote?: string };
      const identity = request.session.get("identity")!;
      const project = request.project!;

      const existing = await prisma.jobRequirement.findFirst({
        where: { id: requirementId, projectId: project.id },
      });
      if (!existing) return reply.code(404).send({ error: "requirement_not_found" });

      const aiWeight = existing.aiSuggestedWeight ? Number(existing.aiSuggestedWeight) : null;
      if (weightChangeRequiresNote(aiWeight, body.weight) && !body.hrNote) {
        return reply.code(400).send({ error: "hr_note_required" });
      }

      const updated = await prisma.jobRequirement.update({
        where: { id: requirementId },
        data: { hrApprovedWeight: body.weight },
      });

      await prisma.requirementWeightApproval.create({
        data: {
          requirementId,
          approvedBy: identity.userId,
          previousWeight: existing.hrApprovedWeight ?? existing.aiSuggestedWeight,
          newWeight: body.weight,
          hrNote: body.hrNote,
        },
      });

      await recordAudit({
        actorId: identity.userId,
        action: "REQUIREMENT_WEIGHT_CHANGED",
        entityType: "JobRequirement",
        entityId: requirementId,
        before: { weight: existing.hrApprovedWeight },
        after: { weight: body.weight, hrNote: body.hrNote },
      });

      return updated;
    },
  );

  // Final approval: deterministic total-must-equal-100 validation, then one
  // immutable JobRequirementVersion snapshot per requirement (Section 10),
  // requirement status -> APPROVED, project status -> READY_FOR_CV_UPLOAD
  // once every non-archived requirement is approved.
  app.post(
    "/projects/:projectId/requirements/approve",
    { preHandler: requireProjectAccess() },
    async (request, reply) => {
      const identity = request.session.get("identity")!;
      const project = request.project!;

      const requirements = await prisma.jobRequirement.findMany({
        where: { projectId: project.id, status: { not: "ARCHIVED" } },
        include: { criteria: { orderBy: { sortOrder: "asc" } } },
      });
      if (requirements.length === 0) {
        return reply.code(400).send({ error: "no_requirements" });
      }

      const weights = requirements.map((r) => ({
        requirementId: r.id,
        weight: Number(r.hrApprovedWeight ?? r.aiSuggestedWeight ?? 0),
      }));
      const validation = validateWeightTotal(weights);
      if (!validation.valid) {
        return reply.code(400).send({ error: "weights_must_total_100", total: validation.total });
      }
      if (requirements.some((r) => r.hrApprovedWeight === null)) {
        return reply.code(400).send({ error: "all_weights_must_be_hr_approved" });
      }

      const versions = await prisma.$transaction(async (tx) => {
        const created = [];
        for (const r of requirements) {
          const snapshot = buildRequirementVersionSnapshot(
            {
              category: r.category,
              customCategoryLabel: r.customCategoryLabel,
              description: r.description,
              mandatory: r.mandatory,
              priority: r.priority,
              aiInterpretationSummary: r.aiInterpretationSummary,
              aiSuggestedWeight: r.aiSuggestedWeight ? Number(r.aiSuggestedWeight) : null,
              criteria: r.criteria.map((c) => c.description),
            },
            r.currentVersionNumber,
            Number(r.hrApprovedWeight),
          );

          const version = await tx.jobRequirementVersion.create({
            data: {
              requirementId: r.id,
              versionNumber: snapshot.versionNumber,
              category: snapshot.category as never,
              customCategoryLabel: snapshot.customCategoryLabel,
              description: snapshot.description,
              mandatory: snapshot.mandatory,
              priority: snapshot.priority as never,
              evidenceCriteriaSnapshot: snapshot.evidenceCriteriaSnapshot,
              aiInterpretationSummary: snapshot.aiInterpretationSummary,
              aiSuggestedWeight: snapshot.aiSuggestedWeight,
              hrApprovedWeight: snapshot.hrApprovedWeight,
              approvedBy: identity.userId,
            },
          });

          await tx.jobRequirement.update({
            where: { id: r.id },
            data: { status: "APPROVED", currentVersionNumber: snapshot.versionNumber },
          });

          created.push(version);
        }
        return created;
      });

      for (const version of versions) {
        await recordAudit({
          actorId: identity.userId,
          action: "REQUIREMENT_VERSION_APPROVED",
          entityType: "JobRequirementVersion",
          entityId: version.id,
          after: version,
        });
      }

      const updatedProject = await prisma.recruitmentProject.update({
        where: { id: project.id },
        data: { status: "READY_FOR_CV_UPLOAD" },
      });

      await recordAudit({
        actorId: identity.userId,
        action: "PROJECT_STATUS_CHANGED",
        entityType: "RecruitmentProject",
        entityId: project.id,
        before: { status: project.status },
        after: { status: updatedProject.status },
      });

      return { project: updatedProject, versions };
    },
  );
}

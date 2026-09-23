import type { FastifyReply, FastifyRequest } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { canAccessProject, canManageProject } from "@recruitment-platform/shared-types";

/**
 * Server-side project access gate (architecture doc Phase 2, Section 1).
 * Every project-scoped route (path contains :projectId) must use one of
 * these as a preHandler — never rely on the frontend to hide a link.
 * Decision logic itself lives in the pure canAccessProject/canManageProject
 * functions (packages/shared-types) so it's unit-testable without a DB;
 * this module only does the I/O (look up the membership row) and calls it.
 */
export function requireProjectAccess() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = request.session.get("identity");
    if (!identity) return reply.code(401).send({ error: "unauthenticated" });

    const { projectId } = request.params as { projectId: string };
    const project = await prisma.recruitmentProject.findUnique({ where: { id: projectId } });
    if (!project) return reply.code(404).send({ error: "project_not_found" });

    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: identity.userId } },
    });

    const allowed = canAccessProject({
      systemRole: identity.role,
      isProjectMember: Boolean(membership),
    });

    if (!allowed) {
      // 404, not 403: a project ID an unauthorized user knows about should
      // not even confirm the project exists (Phase 2, Section 1 — "must NOT
      // be able to access another project simply by knowing its ID").
      return reply.code(404).send({ error: "project_not_found" });
    }

    request.project = project;
    request.projectMembership = membership;
  };
}

export function requireProjectManage() {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = request.session.get("identity");
    if (!identity) return reply.code(401).send({ error: "unauthenticated" });

    const { projectId } = request.params as { projectId: string };
    const project = await prisma.recruitmentProject.findUnique({ where: { id: projectId } });
    if (!project) return reply.code(404).send({ error: "project_not_found" });

    const membership = await prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: identity.userId } },
    });

    const canRead = canAccessProject({
      systemRole: identity.role,
      isProjectMember: Boolean(membership),
    });
    if (!canRead) return reply.code(404).send({ error: "project_not_found" });

    const canManage = canManageProject({
      systemRole: identity.role,
      projectRole: membership?.role ?? null,
    });
    if (!canManage) return reply.code(403).send({ error: "forbidden" });

    request.project = project;
    request.projectMembership = membership;
  };
}

import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { requireAuth } from "../auth/rbac.js";
import { requireProjectAccess, requireProjectManage } from "./authorization.js";
import { recordAudit } from "../../lib/audit.js";

const ALLOWED_STATUS_TRANSITIONS: Record<string, string[]> = {
  DRAFT: ["ACTIVE", "ARCHIVED"],
  ACTIVE: ["ON_HOLD", "READY_FOR_CV_UPLOAD", "ARCHIVED"],
  ON_HOLD: ["ACTIVE", "ARCHIVED"],
  READY_FOR_CV_UPLOAD: ["ON_HOLD", "COMPLETED", "ARCHIVED"],
  COMPLETED: ["ARCHIVED"],
  ARCHIVED: [],
};

export async function registerProjectRoutes(app: FastifyInstance): Promise<void> {
  // Create — the creator becomes the project's OWNER (ProjectMember), not
  // just RecruitmentProject.createdBy, so the authorization check in
  // authorization.ts has one thing to look at.
  app.post("/projects", { preHandler: requireAuth() }, async (request) => {
    const body = request.body as {
      title: string;
      department?: string;
      businessUnit?: string;
      location?: string;
      hiringManager?: string;
      vacancies?: number;
      employmentType?: string;
      description?: string;
    };
    const identity = request.session.get("identity")!;

    const project = await prisma.$transaction(async (tx) => {
      const created = await tx.recruitmentProject.create({
        data: {
          title: body.title,
          department: body.department,
          businessUnit: body.businessUnit,
          location: body.location,
          hiringManager: body.hiringManager,
          vacancies: body.vacancies ?? 1,
          employmentType: body.employmentType,
          description: body.description,
          status: "DRAFT",
          createdBy: identity.userId,
        },
      });
      await tx.projectMember.create({
        data: { projectId: created.id, userId: identity.userId, role: "OWNER" },
      });
      return created;
    });

    await recordAudit({
      actorId: identity.userId,
      action: "PROJECT_CREATED",
      entityType: "RecruitmentProject",
      entityId: project.id,
      after: project,
    });

    return project;
  });

  // List — scoped server-side: HR_ADMIN/SYSTEM_ADMIN see everything,
  // HR_USER sees only projects they are a member of (never trust a client
  // filter for this).
  app.get("/projects", { preHandler: requireAuth() }, async (request) => {
    const identity = request.session.get("identity")!;

    if (identity.role === "HR_ADMIN" || identity.role === "SYSTEM_ADMIN") {
      return prisma.recruitmentProject.findMany({ orderBy: { createdAt: "desc" } });
    }

    return prisma.recruitmentProject.findMany({
      where: { members: { some: { userId: identity.userId } } },
      orderBy: { createdAt: "desc" },
    });
  });

  app.get(
    "/projects/:projectId",
    { preHandler: requireProjectAccess() },
    async (request) => {
      const members = await prisma.projectMember.findMany({
        where: { projectId: request.project!.id },
        include: { user: { select: { id: true, name: true, email: true, role: true } } },
      });
      return { ...request.project, members };
    },
  );

  app.patch(
    "/projects/:projectId",
    { preHandler: requireProjectManage() },
    async (request, reply) => {
      const body = request.body as Partial<{
        title: string;
        department: string;
        businessUnit: string;
        location: string;
        hiringManager: string;
        vacancies: number;
        employmentType: string;
        description: string;
      }>;
      const identity = request.session.get("identity")!;
      const before = request.project!;

      if (before.status === "ARCHIVED") {
        return reply.code(400).send({ error: "project_archived" });
      }

      const updated = await prisma.recruitmentProject.update({
        where: { id: before.id },
        data: body,
      });

      await recordAudit({
        actorId: identity.userId,
        action: "PROJECT_EDITED",
        entityType: "RecruitmentProject",
        entityId: before.id,
        before,
        after: updated,
      });

      return updated;
    },
  );

  // Status transitions go through their own endpoint (not the general
  // PATCH) so the allowed-transition table is the one deterministic gate —
  // never a free-text status write (Phase 2, Section 2: "controlled and
  // auditable").
  app.post(
    "/projects/:projectId/status",
    { preHandler: requireProjectManage() },
    async (request, reply) => {
      const { status: nextStatus } = request.body as { status: string };
      const identity = request.session.get("identity")!;
      const before = request.project!;

      const allowed = ALLOWED_STATUS_TRANSITIONS[before.status] ?? [];
      if (!allowed.includes(nextStatus)) {
        return reply
          .code(400)
          .send({ error: "invalid_status_transition", from: before.status, to: nextStatus, allowed });
      }

      const updated = await prisma.recruitmentProject.update({
        where: { id: before.id },
        data: { status: nextStatus as never },
      });

      await recordAudit({
        actorId: identity.userId,
        action: "PROJECT_STATUS_CHANGED",
        entityType: "RecruitmentProject",
        entityId: before.id,
        before: { status: before.status },
        after: { status: updated.status },
      });

      return updated;
    },
  );

  app.post(
    "/projects/:projectId/members",
    { preHandler: requireProjectManage() },
    async (request, reply) => {
      const body = request.body as { userId: string; role?: "OWNER" | "MEMBER" };
      const identity = request.session.get("identity")!;
      const project = request.project!;

      const targetUser = await prisma.user.findUnique({ where: { id: body.userId } });
      if (!targetUser) return reply.code(404).send({ error: "user_not_found" });

      const member = await prisma.projectMember.upsert({
        where: { projectId_userId: { projectId: project.id, userId: body.userId } },
        update: { role: body.role ?? "MEMBER" },
        create: { projectId: project.id, userId: body.userId, role: body.role ?? "MEMBER" },
      });

      await recordAudit({
        actorId: identity.userId,
        action: "PROJECT_MEMBER_ASSIGNED",
        entityType: "RecruitmentProject",
        entityId: project.id,
        after: { userId: body.userId, role: member.role },
      });

      return member;
    },
  );

  app.delete(
    "/projects/:projectId/members/:userId",
    { preHandler: requireProjectManage() },
    async (request, reply) => {
      const { userId } = request.params as { userId: string };
      const identity = request.session.get("identity")!;
      const project = request.project!;

      const member = await prisma.projectMember.findUnique({
        where: { projectId_userId: { projectId: project.id, userId } },
      });
      if (!member) return reply.code(404).send({ error: "member_not_found" });
      if (member.role === "OWNER") {
        return reply.code(400).send({ error: "cannot_remove_owner" });
      }

      await prisma.projectMember.delete({ where: { id: member.id } });

      await recordAudit({
        actorId: identity.userId,
        action: "PROJECT_MEMBER_REMOVED",
        entityType: "RecruitmentProject",
        entityId: project.id,
        before: { userId, role: member.role },
      });

      return reply.code(204).send();
    },
  );
}

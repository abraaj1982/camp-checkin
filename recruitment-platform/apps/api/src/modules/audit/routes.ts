import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { requireProjectAccess } from "../projects/authorization.js";
import { fetchProjectAuditLog, DEFAULT_PAGE_SIZE } from "./project-scope.js";
import { presentAuditLogRow } from "./presentation.js";

/**
 * Audit Read API (approved design, revision 2) — the first and only read
 * surface for AuditLog. Reuses requireProjectAccess() exactly like every
 * other project-scoped GET route: any project member (or HR_ADMIN/
 * SYSTEM_ADMIN) can read; a non-member gets 404, never 403, matching the
 * existing "don't confirm a project exists to someone unauthorized"
 * convention used everywhere else in this module.
 */
export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/projects/:projectId/audit-log",
    { preHandler: requireProjectAccess() },
    async (request) => {
      const project = request.project!;
      const query = request.query as { page?: string; pageSize?: string };
      const page = query.page !== undefined ? Number(query.page) : undefined;
      const pageSize = query.pageSize !== undefined ? Number(query.pageSize) : DEFAULT_PAGE_SIZE;

      const result = await fetchProjectAuditLog(project.id, { page, pageSize });

      const actorIds = [...new Set(result.rows.map((r) => r.actorId).filter((id): id is string => id !== null))];
      const actors =
        actorIds.length === 0
          ? []
          : await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } });
      const actorNamesById = new Map(actors.map((a) => [a.id, a.name]));

      return {
        events: result.rows.map((row) => presentAuditLogRow(row, actorNamesById)),
        page: result.page,
        pageSize: result.pageSize,
        hasMore: result.hasMore,
      };
    },
  );
}

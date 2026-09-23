import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import { requireAuth } from "../auth/rbac.js";

/**
 * Minimal user lookup so a project OWNER can find a teammate's user ID to
 * assign them (Phase 2, Section 2: "Assign HR users to the project"). Kept
 * deliberately narrow — exact email match only, no directory browsing — a
 * fuller people-picker is a UI nicety for a later phase, not required for
 * the Phase 2 completion criteria.
 */
export async function registerUserRoutes(app: FastifyInstance): Promise<void> {
  app.get("/users", { preHandler: requireAuth() }, async (request) => {
    const { search } = request.query as { search?: string };
    if (!search) return [];

    return prisma.user.findMany({
      where: { email: search.toLowerCase().trim(), isActive: true },
      select: { id: true, name: true, email: true, role: true },
      take: 5,
    });
  });
}

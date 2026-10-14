import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "@recruitment-platform/db";
import { requireAuth, requireRole } from "../auth/rbac.js";
import { EmailPasswordStrategy } from "../auth/email-password-strategy.js";
import { recordAudit } from "../../lib/audit.js";

const assignableRoleSchema = z.enum(["HR_USER", "HR_ADMIN", "SYSTEM_ADMIN"]);
const createUserBodySchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1),
  password: z.string().min(8),
  role: assignableRoleSchema.optional().default("HR_USER"),
});

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

  // Admin-only account creation — the only way to add an HR user before
  // this was the seed script / a direct DB write. Mirrors the existing
  // candidate-purge module's requireRole("HR_ADMIN", "SYSTEM_ADMIN") gate.
  // Never returns passwordHash.
  app.post("/users", { preHandler: requireRole("HR_ADMIN", "SYSTEM_ADMIN") }, async (request, reply) => {
    const parsed = createUserBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid_input", issues: parsed.error.issues });
    }
    const { email, name, password, role } = parsed.data;

    const identity = request.session.get("identity")!;

    // Privilege-escalation guard (server-side only — the frontend role
    // picker is not a security boundary): only a SYSTEM_ADMIN may mint
    // another SYSTEM_ADMIN. HR_ADMIN may create HR_USER or HR_ADMIN peer
    // accounts — this codebase's existing convention (canAccessProject/
    // canManageProject, packages/shared-types/src/project-authorization.ts)
    // already treats HR_ADMIN and SYSTEM_ADMIN as equivalent for ordinary
    // project access/management, so this is the one place SYSTEM_ADMIN is
    // treated as a strict superset — reserved for the one meta-level action
    // (minting other admins) with no existing precedent either way. An
    // unrecognized role string is already rejected above (400, never
    // silently downgraded); this only concerns a valid-but-unauthorized role.
    if (role === "SYSTEM_ADMIN" && identity.role !== "SYSTEM_ADMIN") {
      return reply.code(403).send({ error: "role_not_authorized" });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return reply.code(409).send({ error: "email_already_exists" });
    }

    const user = await prisma.user.create({
      data: {
        email,
        name,
        role,
        passwordHash: await EmailPasswordStrategy.hashPassword(password),
      },
      select: { id: true, email: true, name: true, role: true, isActive: true, createdAt: true },
    });

    await recordAudit({
      actorId: identity.userId,
      action: "USER_CREATED",
      entityType: "User",
      entityId: user.id,
      after: { email: user.email, role: user.role },
    });

    return reply.code(201).send(user);
  });
}

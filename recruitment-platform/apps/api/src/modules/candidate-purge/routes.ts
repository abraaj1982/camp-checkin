import type { FastifyInstance } from "fastify";
import { prisma } from "@recruitment-platform/db";
import type { ObjectStorage } from "@recruitment-platform/storage";
import { executeCandidatePurge, findEligibleCandidateIds } from "@recruitment-platform/candidate-retention";
import { requireRole } from "../auth/rbac.js";

/**
 * Phase 8 — PII Retention/Purge. Admin-only manual trigger and eligibility
 * listing. Both call the exact same executeCandidatePurge/
 * findEligibleCandidateIds implementation the scheduled worker scan uses
 * (@recruitment-platform/candidate-retention) — no `force` override, no
 * second purge implementation. Neither endpoint ever returns a candidate
 * identity field — only ids and counts.
 */
export async function registerCandidatePurgeRoutes(app: FastifyInstance, storage: ObjectStorage): Promise<void> {
  app.get(
    "/admin/candidates/purge-eligible",
    { preHandler: requireRole("HR_ADMIN", "SYSTEM_ADMIN") },
    async () => {
      const candidateIds = await findEligibleCandidateIds();
      return { candidateIds, count: candidateIds.length };
    },
  );

  app.post(
    "/admin/candidates/:id/purge",
    { preHandler: requireRole("HR_ADMIN", "SYSTEM_ADMIN") },
    async (request, reply) => {
      const { id: candidateId } = request.params as { id: string };
      const identity = request.session.get("identity")!;

      const exists = await prisma.candidate.findUnique({ where: { id: candidateId }, select: { id: true } });
      if (!exists) return reply.code(404).send({ error: "candidate_not_found" });

      const result = await executeCandidatePurge(candidateId, "MANUAL", identity.userId, { storage });

      if (result.status === "NOT_ELIGIBLE") {
        return reply.code(409).send({ error: "not_eligible" });
      }
      if (result.status === "ALREADY_PURGED") {
        return { candidateId, status: "ALREADY_PURGED" };
      }
      return { candidateId, status: "PURGED", documentCount: result.documentCount };
    },
  );
}

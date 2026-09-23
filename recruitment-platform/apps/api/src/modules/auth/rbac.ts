import type { FastifyReply, FastifyRequest } from "fastify";

export type Role = "HR_USER" | "HR_ADMIN" | "SYSTEM_ADMIN";

/**
 * Server-side RBAC gate (architecture doc, Section: Authentication &
 * Authorization — "the API is the actual gate"). The frontend hiding a
 * control is a UX nicety only; every mutating/sensitive route calls this.
 */
export function requireRole(...allowed: Role[]) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const identity = request.session.get("identity");
    if (!identity) {
      return reply.code(401).send({ error: "unauthenticated" });
    }
    if (!allowed.includes(identity.role)) {
      return reply.code(403).send({ error: "forbidden" });
    }
  };
}

export function requireAuth() {
  return requireRole("HR_USER", "HR_ADMIN", "SYSTEM_ADMIN");
}

import type { FastifyInstance } from "fastify";
import { EmailPasswordStrategy } from "./email-password-strategy.js";
import { recordAudit } from "../../lib/audit.js";

const strategy = new EmailPasswordStrategy();

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  app.post("/auth/login", async (request, reply) => {
    const body = request.body as { email?: string; password?: string };
    const identity = await strategy.authenticate({
      email: body.email,
      password: body.password,
    });

    if (!identity) {
      return reply.code(401).send({ error: "invalid_credentials" });
    }

    request.session.set("identity", identity);
    await recordAudit({
      actorId: identity.userId,
      action: "LOGIN",
      entityType: "User",
      entityId: identity.userId,
    });

    return { userId: identity.userId, email: identity.email, role: identity.role };
  });

  app.post("/auth/logout", async (request, reply) => {
    const identity = request.session.get("identity");
    await request.session.destroy();
    if (identity) {
      await recordAudit({
        actorId: identity.userId,
        action: "LOGOUT",
        entityType: "User",
        entityId: identity.userId,
      });
    }
    return reply.code(204).send();
  });

  app.get("/auth/me", async (request, reply) => {
    const identity = request.session.get("identity");
    if (!identity) return reply.code(401).send({ error: "unauthenticated" });
    return identity;
  });
}

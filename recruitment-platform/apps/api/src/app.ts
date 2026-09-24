import Fastify, { type FastifyInstance } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import fastifyMultipart from "@fastify/multipart";
import { AiGateway, type AIProvider } from "@recruitment-platform/ai-gateway";
import type { ObjectStorage } from "@recruitment-platform/storage";
import type { CandidateDocumentQueue } from "@recruitment-platform/queue";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerUserRoutes } from "./modules/users/routes.js";
import { registerProjectRoutes } from "./modules/projects/routes.js";
import { registerRequirementRoutes } from "./modules/requirements/routes.js";
import { registerDecisionRoutes } from "./modules/decisions/routes.js";
import { registerCandidateRoutes } from "./modules/candidates/routes.js";
import { registerAssessmentRoutes } from "./modules/assessments/routes.js";

export interface BuildAppOptions {
  sessionSecret: string;
  nodeEnv: string;
  providers: Record<string, AIProvider>;
  storage: ObjectStorage;
  queue: CandidateDocumentQueue;
  logger?: boolean;
}

const MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // matches validateUpload's per-file limit

/**
 * Builds (but does not start) the Fastify app. Split out from server.ts so
 * integration tests can construct the same wiring against `app.inject()`
 * without opening a real port, and so a mocked AIProvider/ObjectStorage/
 * CandidateDocumentQueue can be swapped in without touching route code
 * (architecture doc: "no application module calls the Claude SDK/storage/
 * queue vendor library directly").
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? true });

  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: options.sessionSecret,
    cookie: { secure: options.nodeEnv === "production", httpOnly: true, sameSite: "lax" },
  });
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 30 },
  });

  const gateway = new AiGateway(options.providers);

  app.get("/health", async () => ({ status: "ok" }));

  await registerAuthRoutes(app);
  await registerUserRoutes(app);
  await registerProjectRoutes(app);
  await registerRequirementRoutes(app, gateway);
  await registerDecisionRoutes(app);
  await registerCandidateRoutes(app, options.storage, options.queue);
  await registerAssessmentRoutes(app);

  return app;
}

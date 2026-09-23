import Fastify from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifySession from "@fastify/session";
import { AiGateway, ClaudeProvider } from "@recruitment-platform/ai-gateway";
import { config } from "./lib/config.js";
import { registerAuthRoutes } from "./modules/auth/routes.js";
import { registerRequirementRoutes } from "./modules/requirements/routes.js";
import { registerDecisionRoutes } from "./modules/decisions/routes.js";

async function main() {
  const app = Fastify({ logger: true });

  await app.register(fastifyCookie);
  await app.register(fastifySession, {
    secret: config.sessionSecret,
    cookie: { secure: config.nodeEnv === "production", httpOnly: true, sameSite: "lax" },
  });

  // Claude is the only concrete provider registered for V1 (architecture
  // doc, Decision 3); the gateway itself has no idea which provider a task
  // uses until it reads AiModelConfiguration at call time. Adding
  // OpenAIProvider/GeminiProvider later is one more entry in this map.
  const providers: Record<string, InstanceType<typeof ClaudeProvider>> = {};
  if (config.anthropicApiKey) {
    providers.claude = new ClaudeProvider(config.anthropicApiKey);
  }
  const gateway = new AiGateway(providers);

  app.get("/health", async () => ({ status: "ok" }));

  await registerAuthRoutes(app);
  await registerRequirementRoutes(app, gateway);
  await registerDecisionRoutes(app);

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

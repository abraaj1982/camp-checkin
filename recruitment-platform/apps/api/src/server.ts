import { ClaudeProvider, type AIProvider } from "@recruitment-platform/ai-gateway";
import { config } from "./lib/config.js";
import { buildApp } from "./app.js";

async function main() {
  // Claude is the only concrete provider registered for V1 (architecture
  // doc, Decision 3); the gateway itself has no idea which provider a task
  // uses until it reads AiModelConfiguration at call time. Adding
  // OpenAIProvider/GeminiProvider later is one more entry in this map.
  const providers: Record<string, AIProvider> = {};
  if (config.anthropicApiKey) {
    providers.claude = new ClaudeProvider(config.anthropicApiKey);
  }

  const app = await buildApp({
    sessionSecret: config.sessionSecret,
    nodeEnv: config.nodeEnv,
    providers,
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

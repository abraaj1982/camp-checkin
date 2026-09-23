import { ClaudeProvider, type AIProvider } from "@recruitment-platform/ai-gateway";
import { S3ObjectStorage, LocalObjectStorage, type ObjectStorage } from "@recruitment-platform/storage";
import { PgBossCandidateDocumentQueue } from "@recruitment-platform/queue";
import { config } from "./lib/config.js";
import { buildApp } from "./app.js";

function buildStorage(): ObjectStorage {
  if (process.env.OBJECT_STORAGE_DRIVER === "local") {
    return new LocalObjectStorage(process.env.OBJECT_STORAGE_LOCAL_DIR ?? "./.local-object-storage");
  }
  const bucket = config.objectStorage.bucket;
  const accessKeyId = config.objectStorage.accessKeyId;
  const secretAccessKey = config.objectStorage.secretAccessKey;
  if (!bucket || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "Missing OBJECT_STORAGE_BUCKET/OBJECT_STORAGE_ACCESS_KEY_ID/OBJECT_STORAGE_SECRET_ACCESS_KEY " +
        "(or set OBJECT_STORAGE_DRIVER=local for local dev without MinIO).",
    );
  }
  return new S3ObjectStorage({
    endpoint: config.objectStorage.endpoint,
    bucket,
    accessKeyId,
    secretAccessKey,
  });
}

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
    storage: buildStorage(),
    queue: new PgBossCandidateDocumentQueue(config.databaseUrl),
  });

  await app.listen({ port: config.port, host: "0.0.0.0" });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});

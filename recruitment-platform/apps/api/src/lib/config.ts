function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

// Fails fast on startup rather than at first use, so a misconfigured
// deployment never silently runs with an empty secret (Section 33).
export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  databaseUrl: required("DATABASE_URL"),
  sessionSecret: required("SESSION_SECRET"),
  // ANTHROPIC_UAT_API_KEY fallback: Claude Code on the web treats
  // ANTHROPIC_API_KEY itself as reserved for its own session auth and does
  // not pass it through to a session's process environment, so a UAT
  // environment stores the real key under this alternate name instead.
  anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_UAT_API_KEY, // required only once auth+db paths are exercised end to end
  objectStorage: {
    endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
    bucket: process.env.OBJECT_STORAGE_BUCKET,
    accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY_ID,
    secretAccessKey: process.env.OBJECT_STORAGE_SECRET_ACCESS_KEY,
  },
};

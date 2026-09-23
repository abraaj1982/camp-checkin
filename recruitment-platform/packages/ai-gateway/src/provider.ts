import type { AiTaskType } from "@recruitment-platform/shared-types";

export interface AiRunOptions {
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
}

export interface AiRunRequest {
  taskType: AiTaskType;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  // JSON schema (not a zod schema) describing the expected output shape,
  // passed to providers that support constrained/structured output.
  jsonSchema: Record<string, unknown>;
  options?: AiRunOptions;
}

export interface AiRunResult {
  rawText: string;
  // Present when the provider reports usage; used for latency/cost logging,
  // never for business logic.
  usage?: { inputTokens?: number; outputTokens?: number };
}

/**
 * The one interface every module in this codebase calls through. No module
 * outside packages/ai-gateway/src/providers/* may import a vendor SDK
 * directly (architecture doc, Section: AI Provider Abstraction).
 */
export interface AIProvider {
  readonly name: string;
  run(request: AiRunRequest): Promise<AiRunResult>;
}

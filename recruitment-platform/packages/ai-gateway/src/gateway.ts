import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { prisma } from "@recruitment-platform/db";
import { AI_TASK_OUTPUT_SCHEMAS, type AiTaskType } from "@recruitment-platform/shared-types";
import type { AIProvider } from "./provider.js";

export class AiValidationError extends Error {
  constructor(
    public readonly taskType: AiTaskType,
    public readonly issues: z.ZodIssue[],
  ) {
    super(`AI output for ${taskType} failed schema validation after retry`);
  }
}

interface RunTaskInput<T extends AiTaskType> {
  taskType: T;
  systemPrompt: string;
  userPrompt: string;
  inputRef?: string;
}

/**
 * The sole entry point application modules use to call any AI task. Resolves
 * provider/model from AiModelConfiguration (DB-driven, no redeploy to
 * switch), validates the response against the task's zod schema, retries
 * once on failure, and logs every call to AiInteraction. A response that
 * still fails validation after the retry is never persisted as evidence or
 * an assessment (architecture doc, Section 36/37) — callers must handle
 * AiValidationError explicitly.
 */
export class AiGateway {
  constructor(private readonly providers: Record<string, AIProvider>) {}

  async runTask<T extends AiTaskType>(
    input: RunTaskInput<T>,
  ): Promise<z.TypeOf<(typeof AI_TASK_OUTPUT_SCHEMAS)[T]>> {
    const config = await prisma.aiModelConfiguration.findUnique({
      where: { taskType: input.taskType },
    });

    if (!config || !config.isActive) {
      throw new Error(`No active AiModelConfiguration for task ${input.taskType}`);
    }

    const provider = this.providers[config.provider];
    if (!provider) {
      throw new Error(`No AIProvider registered for "${config.provider}"`);
    }

    const schema = AI_TASK_OUTPUT_SCHEMAS[input.taskType];
    const jsonSchema = zodToJsonSchema(schema, input.taskType);

    const attempt = async (correctionNote?: string) => {
      const started = Date.now();
      const result = await provider.run({
        taskType: input.taskType,
        model: config.model,
        systemPrompt: buildStructuredSystemPrompt(input.systemPrompt, jsonSchema, correctionNote),
        userPrompt: input.userPrompt,
        jsonSchema,
        options: {
          temperature: config.temperature ? Number(config.temperature) : undefined,
          maxTokens: config.maxTokens ?? undefined,
          timeoutMs: config.timeoutMs ?? undefined,
        },
      });
      const latencyMs = Date.now() - started;
      return { result, latencyMs };
    };

    let parsed: z.SafeParseReturnType<unknown, unknown> | undefined;
    let lastRawText = "";
    let lastLatencyMs = 0;

    for (let i = 0; i < 2; i += 1) {
      const correctionNote =
        i === 0
          ? undefined
          : `Your previous response did not match the required JSON schema. Issues: ${JSON.stringify(
              parsed && !parsed.success ? parsed.error.issues : [],
            )}. Return ONLY valid JSON matching the schema, with no extra prose.`;

      const { result, latencyMs } = await attempt(correctionNote);
      lastRawText = result.rawText;
      lastLatencyMs = latencyMs;

      const json = safeJsonParse(result.rawText);
      parsed = schema.safeParse(json);
      if (parsed.success) {
        await prisma.aiInteraction.create({
          data: {
            taskType: input.taskType,
            provider: provider.name,
            model: config.model,
            promptVersion: config.promptVersion,
            inputRef: input.inputRef,
            outputJson: parsed.data as never,
            validationStatus: i === 0 ? "VALID" : "RETRIED_VALID",
            latencyMs,
          },
        });
        return parsed.data as z.TypeOf<(typeof AI_TASK_OUTPUT_SCHEMAS)[T]>;
      }
    }

    await prisma.aiInteraction.create({
      data: {
        taskType: input.taskType,
        provider: provider.name,
        model: config.model,
        promptVersion: config.promptVersion,
        inputRef: input.inputRef,
        outputJson: { rawText: lastRawText } as never,
        validationStatus: "FAILED",
        latencyMs: lastLatencyMs,
      },
    });

    throw new AiValidationError(
      input.taskType,
      parsed && !parsed.success ? parsed.error.issues : [],
    );
  }
}

function buildStructuredSystemPrompt(
  taskSystemPrompt: string,
  jsonSchema: Record<string, unknown>,
  correctionNote?: string,
): string {
  return [
    taskSystemPrompt,
    "",
    "Respond with ONLY a single JSON object matching this JSON Schema, and nothing else:",
    JSON.stringify(jsonSchema),
    correctionNote ? `\n${correctionNote}` : "",
  ].join("\n");
}

function safeJsonParse(text: string): unknown {
  try {
    // Providers occasionally wrap JSON in a code fence despite instructions;
    // strip a leading/trailing ``` fence before parsing.
    const stripped = text.trim().replace(/^```(?:json)?\n?/, "").replace(/```$/, "");
    return JSON.parse(stripped);
  } catch {
    return undefined;
  }
}

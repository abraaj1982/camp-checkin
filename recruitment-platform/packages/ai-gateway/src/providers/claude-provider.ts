import Anthropic from "@anthropic-ai/sdk";
import type { AIProvider, AiRunRequest, AiRunResult } from "../provider.js";

/**
 * Vendor-specific translation only — no business logic. Everything the rest
 * of the app needs (task type, schema validation, retry) lives in the
 * AIGateway, not here, so a future OpenAIProvider/GeminiProvider is a
 * same-shape drop-in (architecture doc, Section: AI Provider Abstraction).
 */
export class ClaudeProvider implements AIProvider {
  readonly name = "claude";
  private readonly client: Anthropic;

  constructor(apiKey: string) {
    this.client = new Anthropic({ apiKey });
  }

  async run(request: AiRunRequest): Promise<AiRunResult> {
    const response = await this.client.messages.create({
      model: request.model,
      max_tokens: request.options?.maxTokens ?? 4096,
      temperature: request.options?.temperature,
      system: request.systemPrompt,
      messages: [{ role: "user", content: request.userPrompt }],
      // Claude does not accept a raw JSON Schema as a top-level structured
      // output option the way some providers do; we constrain it via the
      // system prompt (see buildStructuredSystemPrompt in the gateway) and
      // validate the returned JSON with zod in the gateway. If/when the
      // Anthropic API adds native structured-output support, only this
      // adapter changes.
    });

    const textBlock = response.content.find((block) => block.type === "text");

    return {
      rawText: textBlock && "text" in textBlock ? textBlock.text : "",
      usage: {
        inputTokens: response.usage?.input_tokens,
        outputTokens: response.usage?.output_tokens,
      },
    };
  }
}

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Phase 10D — verifies ClaudeProvider passes an explicit per-request
 * timeout and maxRetries: 0 to the Anthropic SDK. Mocks the SDK entirely —
 * no live Anthropic calls are made anywhere in this file.
 */
const createMock = vi.fn();

vi.mock("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: createMock };
    constructor(_opts: unknown) {}
  },
}));

// vi.mock calls are hoisted above imports by vitest, so this static import
// receives the mocked SDK.
import { ClaudeProvider } from "./claude-provider.js";

describe("ClaudeProvider — Phase 10D per-attempt timeout / maxRetries", () => {
  beforeEach(() => {
    createMock.mockReset();
    createMock.mockResolvedValue({ content: [{ type: "text", text: "{}" }], usage: { input_tokens: 1, output_tokens: 1 } });
  });

  it("passes request.options.timeoutMs as the SDK's real per-attempt timeout (18)", async () => {
    const provider = new ClaudeProvider("fake-key");
    await provider.run({
      taskType: "RESUME_INTELLIGENCE",
      model: "claude-x",
      systemPrompt: "sys",
      userPrompt: "user",
      jsonSchema: {},
      options: { timeoutMs: 900_000 },
    });
    expect(createMock).toHaveBeenCalledTimes(1);
    const [, requestOptions] = createMock.mock.calls[0];
    expect(requestOptions.timeout).toBe(900_000);
  });

  it("explicitly passes maxRetries: 0, disabling the SDK's own internal retry layer (19)", async () => {
    const provider = new ClaudeProvider("fake-key");
    await provider.run({
      taskType: "RESUME_INTELLIGENCE",
      model: "claude-x",
      systemPrompt: "sys",
      userPrompt: "user",
      jsonSchema: {},
      options: { timeoutMs: 900_000 },
    });
    const [, requestOptions] = createMock.mock.calls[0];
    expect(requestOptions.maxRetries).toBe(0);
  });

  it("timeout is undefined (SDK default applies) when no timeoutMs is configured — never invents a value", async () => {
    const provider = new ClaudeProvider("fake-key");
    await provider.run({
      taskType: "RESUME_INTELLIGENCE",
      model: "claude-x",
      systemPrompt: "sys",
      userPrompt: "user",
      jsonSchema: {},
    });
    const [, requestOptions] = createMock.mock.calls[0];
    expect(requestOptions.timeout).toBeUndefined();
    expect(requestOptions.maxRetries).toBe(0); // maxRetries: 0 is unconditional, independent of timeoutMs being set
  });

  it("applies identically across repeated calls — the three sequential AI stages share one adapter, one behavior (21)", async () => {
    const provider = new ClaudeProvider("fake-key");
    for (let i = 0; i < 3; i += 1) {
      await provider.run({
        taskType: "RESUME_INTELLIGENCE",
        model: "claude-x",
        systemPrompt: "sys",
        userPrompt: `user-${i}`,
        jsonSchema: {},
        options: { timeoutMs: 900_000 },
      });
    }
    expect(createMock).toHaveBeenCalledTimes(3);
    for (const call of createMock.mock.calls) {
      expect(call[1].timeout).toBe(900_000);
      expect(call[1].maxRetries).toBe(0);
    }
  });

  it("does not change the request body (model/max_tokens/system/messages) passed as the first argument", async () => {
    const provider = new ClaudeProvider("fake-key");
    await provider.run({
      taskType: "RESUME_INTELLIGENCE",
      model: "claude-x",
      systemPrompt: "sys prompt",
      userPrompt: "user prompt",
      jsonSchema: {},
      options: { timeoutMs: 900_000, maxTokens: 2048, temperature: 0.2 },
    });
    const [body] = createMock.mock.calls[0];
    expect(body.model).toBe("claude-x");
    expect(body.max_tokens).toBe(2048);
    expect(body.temperature).toBe(0.2);
    expect(body.system).toBe("sys prompt");
    expect(body.messages).toEqual([{ role: "user", content: "user prompt" }]);
  });
});

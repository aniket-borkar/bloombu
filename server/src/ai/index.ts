import type { AiConfig } from "../config.js";
import { createAnthropicClient, createOpenAiClient, type LlmClient } from "./llm.js";
import { createMockLlm } from "./mockLlm.js";

export function createLlm(ai: AiConfig): LlmClient | null {
  switch (ai.provider) {
    case "openai":
      return createOpenAiClient({ baseUrl: ai.baseUrl ?? "https://api.openai.com/v1", apiKey: ai.apiKey!, model: ai.model!, name: "openai" });
    case "ollama":
      return createOpenAiClient({ baseUrl: ai.baseUrl ?? "http://localhost:11434/v1", apiKey: ai.apiKey ?? "ollama", model: ai.model!, name: "ollama" });
    case "anthropic":
      return createAnthropicClient({ baseUrl: ai.baseUrl ?? "https://api.anthropic.com", apiKey: ai.apiKey!, model: ai.model! });
    case "mock":
      return createMockLlm();
    default:
      return null;
  }
}

/** The client for deep research questions: AI_MODEL_DEEP on the same provider, else the regular client. */
export function createDeepLlm(ai: AiConfig, llm: LlmClient | null): LlmClient | null {
  if (!llm || !ai.deepModel || ai.deepModel === ai.model || ai.provider === "mock") return llm;
  return createLlm({ ...ai, model: ai.deepModel });
}

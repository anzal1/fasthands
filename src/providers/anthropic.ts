// Anthropic Messages API adapter. Plain fetch, no SDK.

import type { ChatMessage, Provider } from "../types.ts";
import { parseActions, postJson } from "./shared.ts";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 2048;

interface AnthropicResponse {
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number };
}

export function createAnthropicProvider(model: string, apiKey?: string): Provider {
  const key = apiKey ?? process.env.ANTHROPIC_API_KEY;

  return {
    id: "anthropic",
    model,
    async complete(messages: ChatMessage[]) {
      const system = messages.find((m) => m.role === "system")?.content;
      const rest = messages
        .filter((m) => m.role !== "system")
        .map((m) => ({ role: m.role, content: m.content }));

      const body: Record<string, unknown> = {
        model,
        max_tokens: MAX_TOKENS,
        messages: rest,
      };
      if (system !== undefined) body.system = system;

      const json = (await postJson(
        ANTHROPIC_API_URL,
        {
          "x-api-key": key ?? "",
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body,
      )) as AnthropicResponse;

      const rawText = (json.content ?? [])
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text)
        .join("");

      const actions = parseActions(rawText);

      return {
        actions,
        rawText,
        usage: {
          inputTokens: json.usage?.input_tokens ?? 0,
          outputTokens: json.usage?.output_tokens ?? 0,
        },
      };
    },
  };
}

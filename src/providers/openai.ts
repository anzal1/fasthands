// OpenAI Chat Completions adapter, and the shared internals reused by
// compat.ts (Ollama/Groq/Together/vLLM speak the same wire format). Plain
// fetch, no SDK.

import type { ChatMessage, Provider } from "../types.ts";
import { parseActions, postJson } from "./shared.ts";

const OPENAI_BASE_URL = "https://api.openai.com/v1";

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Shared factory for any OpenAI-compatible chat/completions endpoint.
 *  Used directly by createOpenAIProvider and re-used by compat.ts. */
export function createOpenAIStyleProvider(
  id: "openai" | "openai-compat",
  model: string,
  baseUrl: string,
  apiKey?: string,
  defaultApiKeyEnvVar: string = "OPENAI_API_KEY",
): Provider {
  const key = apiKey ?? process.env[defaultApiKeyEnvVar];

  return {
    id,
    model,
    async complete(messages: ChatMessage[]) {
      const body = {
        model,
        // FH_SYSTEM_SUFFIX lets a runner append model-specific control tokens
        // to the system prompt without touching the loop — e.g. "/no_think"
        // switches Qwen3-family local models out of chain-of-thought mode,
        // which triples their speed on action emission.
        messages: messages.map((m) => ({
          role: m.role,
          content:
            m.role === "system" && process.env.FH_SYSTEM_SUFFIX
              ? `${m.content}\n${process.env.FH_SYSTEM_SUFFIX}`
              : m.content,
        })),
      };

      const headers: Record<string, string> = {};
      if (key !== undefined) headers.authorization = `Bearer ${key}`;

      const json = (await postJson(
        `${baseUrl}/chat/completions`,
        headers,
        body,
      )) as ChatCompletionsResponse;

      const rawText = json.choices?.[0]?.message?.content ?? "";
      const actions = parseActions(rawText);

      return {
        actions,
        rawText,
        usage: {
          inputTokens: json.usage?.prompt_tokens ?? 0,
          outputTokens: json.usage?.completion_tokens ?? 0,
        },
      };
    },
  };
}

export function createOpenAIProvider(
  model: string,
  apiKey?: string,
  baseUrl: string = OPENAI_BASE_URL,
): Provider {
  return createOpenAIStyleProvider("openai", model, baseUrl, apiKey, "OPENAI_API_KEY");
}

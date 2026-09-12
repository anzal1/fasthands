// Generic OpenAI-compatible adapter: same wire format as openai.ts, any
// base URL. Covers Ollama, Groq, Together, vLLM, etc.

import type { Provider } from "../types.ts";
import { createOpenAIStyleProvider } from "./openai.ts";

export function createCompatProvider(model: string, baseUrl: string, apiKey?: string): Provider {
  return createOpenAIStyleProvider("openai-compat", model, baseUrl, apiKey, "OPENAI_API_KEY");
}

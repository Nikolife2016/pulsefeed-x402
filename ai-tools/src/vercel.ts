// Адаптер под Vercel AI SDK (`ai`). Импортируй из "pulsefeed-x402-ai-tools/vercel".
//
//   import { generateText } from "ai";
//   import { pulsefeedTools } from "pulsefeed-x402-ai-tools/vercel";
//   await generateText({ model, tools: pulsefeedTools, prompt: "..." });
//
// peer-deps: `ai` (>=3) и `zod`.
import { tool } from "ai";
import { z } from "zod";
import { verifyX402Endpoint, x402TrustCatalog, TOOL_DESCRIPTIONS, type PulsefeedOptions } from "./core.js";

/** Инструменты PulseFeed для Vercel AI SDK. С опциями (свой apiUrl/timeout) — createPulsefeedTools. */
export function createPulsefeedTools(opts?: PulsefeedOptions) {
  return {
    verifyX402Endpoint: tool({
      description: TOOL_DESCRIPTIONS.verify,
      parameters: z.object({
        endpoint: z.string().describe("The x402 endpoint URL the agent is about to pay (e.g. https://api.example.com/x402/resource)"),
      }),
      execute: async ({ endpoint }: { endpoint: string }) => verifyX402Endpoint(endpoint, opts),
    }),
    x402TrustCatalog: tool({
      description: TOOL_DESCRIPTIONS.catalog,
      parameters: z.object({}),
      execute: async () => x402TrustCatalog(opts),
    }),
  };
}

/** Готовый набор с дефолтами (https://pulsefeed.dev). */
export const pulsefeedTools = createPulsefeedTools();

// Адаптер под LangChain.js. Импортируй из "pulsefeed-x402-ai-tools/langchain".
//
//   import { pulsefeedTools } from "pulsefeed-x402-ai-tools/langchain";
//   const agent = createReactAgent({ llm, tools: pulsefeedTools });
//
// peer-deps: `@langchain/core` (>=0.2) и `zod`.
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { verifyX402Endpoint, x402TrustCatalog, TOOL_DESCRIPTIONS, type PulsefeedOptions } from "./core.js";

/** Инструменты PulseFeed для LangChain. func возвращает строку (JSON) — как ждёт LangChain. */
export function createPulsefeedTools(opts?: PulsefeedOptions): DynamicStructuredTool[] {
  return [
    new DynamicStructuredTool({
      name: "verify_x402_endpoint",
      description: TOOL_DESCRIPTIONS.verify,
      schema: z.object({
        endpoint: z.string().describe("The x402 endpoint URL the agent is about to pay"),
      }),
      func: async ({ endpoint }: { endpoint: string }) =>
        JSON.stringify(await verifyX402Endpoint(endpoint, opts)),
    }),
    new DynamicStructuredTool({
      name: "x402_trust_catalog",
      description: TOOL_DESCRIPTIONS.catalog,
      schema: z.object({}),
      func: async () => JSON.stringify(await x402TrustCatalog(opts)),
    }),
  ];
}

/** Готовый набор с дефолтами (https://pulsefeed.dev). */
export const pulsefeedTools = createPulsefeedTools();

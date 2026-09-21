// LangChain.js adapter. Import from "pulsefeed-x402-ai-tools/langchain".
//
//   import { pulsefeedTools } from "pulsefeed-x402-ai-tools/langchain";
//   const agent = createReactAgent({ llm, tools: pulsefeedTools });
//
// peer-deps: `@langchain/core` (0.2, 0.3 or 1.x) and `zod`.
import { DynamicStructuredTool, type StructuredToolInterface } from "@langchain/core/tools";
import { z } from "zod";
import { verifyX402Endpoint, x402TrustCatalog, TOOL_DESCRIPTIONS, type PulsefeedOptions } from "./core.js";

/**
 * PulseFeed tools for LangChain. func returns a JSON string, as LangChain expects.
 * The declared return type is the version-stable `StructuredToolInterface[]`: an inferred
 * `DynamicStructuredTool<…>` would bake @langchain/core 1.x's six type parameters into our .d.ts, which a
 * consumer on core 0.3 cannot compile (TS2707; found by the controller 21.09.2026).
 */
export function createPulsefeedTools(opts?: PulsefeedOptions): StructuredToolInterface[] {
  return [
    new DynamicStructuredTool({
      name: "verify_x402_endpoint",
      description: TOOL_DESCRIPTIONS.verify,
      schema: z.object({
        endpoint: z.string().describe("The x402 endpoint URL the agent is about to pay"),
      }),
      func: async ({ endpoint }) => JSON.stringify(await verifyX402Endpoint(endpoint, opts)),
    }),
    new DynamicStructuredTool({
      name: "x402_trust_catalog",
      description: TOOL_DESCRIPTIONS.catalog,
      schema: z.object({}),
      func: async () => JSON.stringify(await x402TrustCatalog(opts)),
    }),
  ];
}

/** Ready-made set with defaults (https://pulsefeed.dev). */
export const pulsefeedTools = createPulsefeedTools();

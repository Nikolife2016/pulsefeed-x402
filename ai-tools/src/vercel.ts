// Vercel AI SDK adapter (`ai`). Import from "pulsefeed-x402-ai-tools/vercel".
//
//   import { generateText } from "ai";
//   import { pulsefeedTools } from "pulsefeed-x402-ai-tools/vercel";
//   await generateText({ model, tools: pulsefeedTools, prompt: "..." });
//
// peer-deps: `ai` (3, 4, 5, 6 or 7) and `zod`.
// The tool objects carry BOTH `parameters` (read by ai@3/4) and `inputSchema` (read by ai@5+): with only
// `parameters`, ai@5+ shows the model an EMPTY schema and the agent never learns it must pass `endpoint`
// (found 21.09.2026 on ai@7). No `tool()` helper import, so no `ai` version is required at build time.
import { z } from "zod";
import { verifyX402Endpoint, x402TrustCatalog, TOOL_DESCRIPTIONS, type PulsefeedOptions, type VerifyResult } from "./core.js";

const verifyInput = z.object({
  endpoint: z.string().describe("The x402 endpoint URL the agent is about to pay (e.g. https://api.example.com/x402/resource)"),
});
const catalogInput = z.object({});

export interface PulsefeedVercelTools {
  verifyX402Endpoint: { description: string; parameters: typeof verifyInput; inputSchema: typeof verifyInput; execute: (input: { endpoint: string }) => Promise<VerifyResult> };
  x402TrustCatalog: { description: string; parameters: typeof catalogInput; inputSchema: typeof catalogInput; execute: () => Promise<any> };
}

/** PulseFeed tools for the Vercel AI SDK. With options (own apiUrl / timeout) — createPulsefeedTools. */
export function createPulsefeedTools(opts?: PulsefeedOptions): PulsefeedVercelTools {
  return {
    verifyX402Endpoint: {
      description: TOOL_DESCRIPTIONS.verify,
      parameters: verifyInput,
      inputSchema: verifyInput,
      execute: async ({ endpoint }) => verifyX402Endpoint(endpoint, opts),
    },
    x402TrustCatalog: {
      description: TOOL_DESCRIPTIONS.catalog,
      parameters: catalogInput,
      inputSchema: catalogInput,
      execute: async () => x402TrustCatalog(opts),
    },
  };
}

/** Ready-made set with defaults (https://pulsefeed.dev). */
export const pulsefeedTools = createPulsefeedTools();

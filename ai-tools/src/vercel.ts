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

/**
 * One tool object as both ai 3/4 (`parameters`) and ai 5+ (`inputSchema`) read it.
 * The schema fields are typed `any` on purpose: naming the Zod object type would bake Zod 3's five type
 * parameters into our .d.ts, which does not compile for a consumer on Zod 4 (TS2707; found by the controller
 * 21.09.2026). Runtime is the consumer's own `zod` (3 or 4); the input type is stated on `execute`.
 */
export type PulsefeedVercelTool<I, O> = { description: string; parameters: any; inputSchema: any; execute: (input: I) => Promise<O> };
/**
 * A type alias (not an interface): `generateText({ tools })` expects a `ToolSet` = `Record<string, Tool>`, and only
 * object type literals get the implicit index signature that makes them assignable to a Record (TS2322 otherwise).
 */
export type PulsefeedVercelTools = {
  verifyX402Endpoint: PulsefeedVercelTool<{ endpoint: string }, VerifyResult>;
  x402TrustCatalog: PulsefeedVercelTool<Record<string, never>, any>;
};

/** PulseFeed tools for the Vercel AI SDK. With options (own apiUrl / timeout) — createPulsefeedTools. */
export function createPulsefeedTools(opts?: PulsefeedOptions): PulsefeedVercelTools {
  return {
    verifyX402Endpoint: {
      description: TOOL_DESCRIPTIONS.verify,
      parameters: verifyInput,
      inputSchema: verifyInput,
      execute: async ({ endpoint }: { endpoint: string }) => verifyX402Endpoint(endpoint, opts),
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

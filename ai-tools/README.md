# pulsefeed-x402-ai-tools

Drop-in AI-agent tools for **x402 payment safety**. Before your agent pays an x402 endpoint, check whether it's actually safe — **~70% of x402 endpoints are dead, invalid, or scams**. Adapters for the **Vercel AI SDK** and **LangChain**, powered by [PulseFeed](https://pulsefeed.dev/status).

Two tools:

- **`verifyX402Endpoint`** — is this x402 URL safe to pay? Returns a pay/avoid verdict with liveness, trust score, scam/anomaly flags, on-chain receiver profile and uptime.
- **`x402TrustCatalog`** — discover working (verified-live) x402 services + the ecosystem risk map.

The check is **free** (PulseFeed's cached verdict). Deep live re-check is available at the paid `/trust` endpoint.

## Install

```bash
npm i pulsefeed-x402-ai-tools zod
# + your framework:
npm i ai                 # for the Vercel AI SDK adapter
npm i @langchain/core    # for the LangChain adapter
```

## Vercel AI SDK

```ts
import { generateText } from "ai";
import { openai } from "@ai-sdk/openai";
import { pulsefeedTools } from "pulsefeed-x402-ai-tools/vercel";

await generateText({
  model: openai("gpt-4o"),
  tools: pulsefeedTools,
  maxSteps: 5,
  prompt: "I want to pay https://api.some-x402-service.com/data — is it safe first?",
});
```

## LangChain

```ts
import { pulsefeedTools } from "pulsefeed-x402-ai-tools/langchain";
import { createReactAgent } from "@langchain/langgraph/prebuilt";

const agent = createReactAgent({ llm, tools: pulsefeedTools });
```

## Core (any framework / no framework)

```ts
import { verifyX402Endpoint, x402TrustCatalog } from "pulsefeed-x402-ai-tools";

const v = await verifyX402Endpoint("https://api.some-x402-service.com/data");
if (v.verdict === "avoid") throw new Error("don't pay this endpoint");
```

## Options

Both adapters export `createPulsefeedTools(opts)` to override defaults:

```ts
import { createPulsefeedTools } from "pulsefeed-x402-ai-tools/vercel";
const tools = createPulsefeedTools({ apiUrl: "https://pulsefeed.dev", timeoutMs: 6000 });
```

## Verdict shape

```jsonc
{
  "endpoint": "https://...",
  "known": true,
  "live": true,
  "verdict": "safe",         // safe | caution | avoid | unknown
  "score": 95,
  "riskLevel": "clean",
  "flags": [],
  "receiverProfile": "established",
  "uptimePct": 98,
  "escalation": { "recommended": false, "reason": "...", "liveCheck": "GET /trust?endpoint=", "priceUsd": 0.02 }
}
```

## Related

- [`pulsefeed-x402-guard`](https://www.npmjs.com/package/pulsefeed-x402-guard) — wrap your paying `fetch` to auto-block dead/scam endpoints.
- [`pulsefeed-x402-mcp`](https://www.npmjs.com/package/pulsefeed-x402-mcp) — the same checks as an MCP server (Claude Desktop / Cursor / Cline).
- [PulseFeed Observatory](https://pulsefeed.dev/status) — live state of the x402 ecosystem.

MIT · by [PulseFeed](https://pulsefeed.dev)

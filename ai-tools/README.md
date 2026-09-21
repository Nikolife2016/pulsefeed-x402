# pulsefeed-x402-ai-tools

Drop-in AI-agent tools for **x402 payment safety**. Before your agent pays an x402 endpoint, check whether it's actually safe — **many listed x402 endpoints are dead, invalid, or scams** (live share: [pulsefeed.dev/status.json](https://pulsefeed.dev/status.json)). Adapters for the **Vercel AI SDK** (`ai` 3–7) and **LangChain** (`@langchain/core` 0.2–1.x), powered by [PulseFeed](https://pulsefeed.dev/status). Node 20+, ESM.

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
if (v.checkFailed) throw new Error("no verdict: " + v.error);   // PulseFeed could not be consulted — not a "safe"
if (v.verdict === "avoid") throw new Error("don't pay this endpoint");
```

`verifyX402Endpoint` never throws. When PulseFeed cannot be consulted (HTTP error, timeout, non-JSON, unexpected body) or the argument is not an http(s) URL, the result carries `checkFailed: true` and `error`, with `verdict: "unknown"` only because no verdict was produced. `x402TrustCatalog` throws `PulseFeedUnavailableError` in those cases; the adapters surface it as a tool error.

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
  "escalation": { "recommended": false, "reason": "...", "liveCheck": "GET /trust?endpoint=", "priceUsd": 0.004 }
}
```

On a failed check: `{ "endpoint": "https://...", "known": false, "verdict": "unknown", "checkFailed": true, "error": "PulseFeed HTTP 503", "advice": "PulseFeed check failed (...). No verdict was produced — ..." }`.

## Development

`npm ci && npm run build && npm test` — the test packs a tarball and installs it in two clean consumer directories (ai 4 + @langchain/core 0.3, ai 7 + @langchain/core 1), then runs the core against a mocked and the live PulseFeed, both adapters (the Vercel tools inside `generateText` with a mock model) and TypeScript consumers.

## Related

- [`pulsefeed-x402-guard`](https://www.npmjs.com/package/pulsefeed-x402-guard) — wrap your paying `fetch` to auto-block dead/scam endpoints.
- [`pulsefeed-x402-mcp`](https://www.npmjs.com/package/pulsefeed-x402-mcp) — the same checks as an MCP server (Claude Desktop / Cursor / Cline).
- [PulseFeed Observatory](https://pulsefeed.dev/status) — live state of the x402 ecosystem.

MIT · by [PulseFeed](https://pulsefeed.dev)

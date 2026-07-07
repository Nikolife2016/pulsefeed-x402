# PulseFeed — open-source x402 client tools

Client-side, MIT-licensed tools for **[PulseFeed](https://pulsefeed.dev)** — the independent **trust & safety layer for the x402 agent-payment economy**.

Before an AI agent pays an x402 endpoint, it should know whether that endpoint is safe to pay — **~70% of x402 endpoints are dead, invalid, or scams**, and only about half of what catalogs call "healthy" actually work. PulseFeed independently probes every x402 service, scans for scams (payTo hijack, bait-and-switch, honeypot), verifies the receiver on-chain, and publishes an open Trust Score.

This repo holds the **open-source client packages**. They talk to PulseFeed's public API (free `/verify`, live `/status`, paid `/trust`). The crawler, scoring engine, and dataset are the service itself at [pulsefeed.dev](https://pulsefeed.dev).

## Packages

| Package | What it does | Install |
|---|---|---|
| [`pulsefeed-x402-ai-tools`](./ai-tools) | Drop-in tools for the **Vercel AI SDK** and **LangChain**: verify an x402 endpoint before your agent pays + discover working services | `npm i pulsefeed-x402-ai-tools` |
| [`pulsefeed-x402-guard`](./sdk) | Wrap your paying `fetch` — every payment is verified first; dead/scam endpoints are blocked automatically (zero deps) | `npm i pulsefeed-x402-guard` |
| [`pulsefeed-x402-mcp`](./mcp) | MCP server: gives Claude Desktop / Cursor / Cline tools to find live x402 services and verify endpoints before paying | `npx -y pulsefeed-x402-mcp` |

## Quick example

```ts
import { verifyX402Endpoint } from "pulsefeed-x402-ai-tools";

const v = await verifyX402Endpoint("https://api.some-x402-service.com/data");
if (v.verdict === "avoid") throw new Error("don't pay this endpoint");
```

## MCP config

```json
{ "mcpServers": { "pulsefeed": { "command": "npx", "args": ["-y", "pulsefeed-x402-mcp"] } } }
```

## Links

- 🌐 Live observatory: **[pulsefeed.dev/status](https://pulsefeed.dev/status)** — the live state of x402
- 📊 [State of x402 report](https://pulsefeed.dev/reports) · [Trust Score standard](https://pulsefeed.dev/trust-score) · [Change feed](https://pulsefeed.dev/changes)
- 📖 [Methodology](https://pulsefeed.dev/methodology) · [OpenAPI](https://pulsefeed.dev/openapi.json) · [llms.txt](https://pulsefeed.dev/llms.txt)

MIT © PulseFeed

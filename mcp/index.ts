#!/usr/bin/env node
// PulseFeed MCP server — самодостаточный, зовёт публичные эндпоинты PulseFeed.
// Даёт агентам в Claude Desktop / Cursor / Cline инструменты для навигации по x402-экосистеме.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.PULSEFEED_URL || "https://pulsefeed.dev";

const server = new McpServer({ name: "pulsefeed-x402", version: "1.0.0" });

server.registerTool(
  "x402_working_services",
  {
    description:
      "List x402 agent-payment services that are currently ALIVE and return a valid x402 challenge, ranked by trust score. About 85% of x402 endpoints are dead or invalid — use this to avoid paying broken or scam endpoints. Free.",
    inputSchema: {},
  },
  async () => {
    const r = await fetch(`${BASE}/status.json`);
    const j = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(j, null, 2) }] };
  },
);

server.registerTool(
  "check_x402_endpoint",
  {
    description:
      "Before paying an unknown x402 endpoint, check whether it is live and returns a valid x402 payment challenge. Returns liveness, price, network and a pay/avoid verdict. For full uptime + reputation, use PulseFeed's paid /trust API.",
    inputSchema: { url: z.string().describe("The x402 endpoint URL to verify") },
  },
  async ({ url }) => {
    const out: any = { url, reachable: false, valid: false };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
      clearTimeout(t);
      out.reachable = true;
      out.status = res.status;
      if (res.status === 402) {
        const b: any = await res.json().catch(() => null);
        const a = b?.accepts?.[0];
        out.valid = !!a;
        if (a) { out.price = a.maxAmountRequired; out.network = a.network; out.asset = a.asset; out.payTo = a.payTo; }
      }
    } catch (e: any) {
      out.error = e?.name === "AbortError" ? "timeout" : e?.message;
    }
    out.verdict = out.valid ? "live — valid x402, safe to consider paying" : "avoid — no valid x402 challenge";
    out.fullReputation = `${BASE}/trust?endpoint=${encodeURIComponent(url)} (paid: adds uptime + reputation history)`;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

server.registerTool(
  "pulsefeed_products",
  {
    description:
      "List PulseFeed's paid x402 products — real-time Base on-chain intelligence for AI agents: token pulse, whale alerts, smart-money accumulation/distribution, momentum, and the x402 trust oracle — and how to pay via x402.",
    inputSchema: {},
  },
  async () => {
    const r = await fetch(`${BASE}/`);
    const j = await r.json();
    return { content: [{ type: "text", text: JSON.stringify(j, null, 2) }] };
  },
);

await server.connect(new StdioServerTransport());
console.error("pulsefeed-x402 MCP server running on stdio");

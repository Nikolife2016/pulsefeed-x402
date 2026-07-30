#!/usr/bin/env node
// PulseFeed MCP server — самодостаточный, зовёт публичные эндпоинты PulseFeed.
// Даёт агентам в Claude Desktop / Cursor / Cline инструменты для навигации по x402-экосистеме.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = process.env.PULSEFEED_URL || "https://pulsefeed.dev";

const server = new McpServer({ name: "pulsefeed-x402", version: "1.0.3" });

server.registerTool(
  "x402_working_services",
  {
    title: "List live x402 services",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    title: "Check an x402 endpoint before paying",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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
    // Дообогащение из непрерывного аудита PulseFeed: флаги скама/аномалий + trust score из кэша.
    try {
      const v: any = await (await fetch(`${BASE}/verify?endpoint=${encodeURIComponent(url)}`)).json();
      if (v && v.known) { out.trustScore = v.score; out.registryVerdict = v.verdict; out.knownFlags = v.flags; out.receiverStability = v.receiverStability; out.uptimePct = v.uptimePct; }
    } catch { /* кэш недоступен — живая проба выше уже дала вердикт */ }
    out.verdict = out.valid ? "live — valid x402, safe to consider paying" : "avoid — no valid x402 challenge";
    out.fullReputation = `${BASE}/trust?endpoint=${encodeURIComponent(url)} (paid: adds uptime + reputation history)`;
    return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
  },
);

server.registerTool(
  "pulsefeed_products",
  {
    title: "PulseFeed products and pricing",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
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


// ---- Бесплатные data-тулы (обёртки публичных эндпоинтов PulseFeed) ----

const textOf = (j: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(j, null, 2) }] });
const getJson = async (path: string) => (await fetch(`${BASE}${path}`)).json();

server.registerTool(
  "x402_ecosystem_stats",
  { title: "x402 ecosystem health stats",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Live health of the entire x402 agent-payment ecosystem: how many endpoints are tracked/alive/dead, catalog accuracy audit (what share of 'healthy' listings actually work), scam-risk distribution and receiver-stability breakdown. Compact aggregates from PulseFeed's continuous independent audit. Free.", inputSchema: {} },
  async () => { const j: any = await getJson("/status.json"); return textOf({ ecosystem: j.ecosystem, catalogAudit: j.catalogAudit, security: j.security ? { riskByLevel: j.security.riskByLevel, flagCounts: j.security.flagCounts } : null, receiverStability: j.receiverStability, receiverOnchain: j.receiverOnchain, analytics: j.analytics }); },
);

server.registerTool(
  "x402_leaderboard",
  { title: "x402 trust leaderboard",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Top x402 services ranked by PulseFeed Trust Score (0-100, open standard): the most reliable live agent-payment endpoints right now, with price and network. Use to pick a trustworthy service to pay. Free.", inputSchema: {} },
  async () => { const j: any = await getJson("/status.json"); return textOf({ topHealthy: j.topHealthy, topProviders: j.topProviders, trustScoreSpec: `${BASE}/trust-score.json` }); },
);

server.registerTool(
  "x402_incidents",
  { title: "Live x402 security incidents",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Live security incidents in the x402 economy caught by PulseFeed's detector: receiver hijacks (payTo swapped), bait-and-switch pricing, honeypots, unverified receivers, price gouging — each with an on-chain proof URL. Check before paying anything. Free.", inputSchema: {} },
  async () => { const j: any = await getJson("/incidents.json?days=30&limit=50"); return textOf(j); },
);

server.registerTool(
  "x402_changes",
  { title: "Recent x402 ecosystem changes",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "What changed in the x402 ecosystem in the last 7 days: services that went dark, receiver (payTo) swaps — possible hijacks, price changes, recovered and newly-seen services. Derived from PulseFeed's compounding time-series (cannot be reconstructed after the fact). Free.", inputSchema: {} },
  async () => { const j: any = await getJson("/changes.json?days=7&limit=100"); return textOf(j); },
);

server.registerTool(
  "mcp_security_report",
  { title: "State of MCP security",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "State of MCP Security: how many audited MCP servers run an arbitrary install script on npm i, are abandoned, ship no repository or license — with day-over-day deltas and a sample of currently-flagged servers. From PulseFeed's daily MCP audit (950+ servers). Free.", inputSchema: {} },
  async () => { const j: any = await getJson("/mcp-report.json"); return textOf({ current: j.current, deltas: j.deltas, riskySample: j.live ? j.live.riskySample : [] }); },
);

server.registerTool(
  "mcp_check_server",
  { title: "Audit an MCP server before installing",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Before installing an MCP server, audit it by npm package name: does it run an install script (arbitrary code at npm i), is it abandoned, does it ship a repository/license, weekly downloads, provenance — verdict safe/caution/avoid. Free.", inputSchema: { package: z.string().describe("npm package name of the MCP server, e.g. @scope/name") } },
  async ({ package: pkg }) => { const j: any = await getJson(`/mcp/verify?package=${encodeURIComponent(pkg)}`); return textOf(j); },
);

server.registerTool(
  "x402_data_sample",
  { title: "Free sample of the trust dataset",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "FREE sample of the PulseFeed Data API: top-10 live x402 services as FULL records (compounding payTo/price history, scam flags, on-chain receiver profile), top-10 MCP servers with full audit profile, and 3 live incidents. The full cross-domain dataset is GET /data/full ($1 via x402). Free.", inputSchema: {} },
  async () => { const j: any = await getJson("/data/sample"); return textOf(j); },
);

await server.connect(new StdioServerTransport());
console.error("pulsefeed-x402 MCP server running on stdio");

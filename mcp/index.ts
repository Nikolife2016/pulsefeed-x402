#!/usr/bin/env node
// PulseFeed MCP server — самодостаточный, зовёт публичные эндпоинты PulseFeed.
// Даёт агентам в Claude Desktop / Cursor / Cline инструменты для навигации по x402-экосистеме.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { safeFetch, SsrfBlocked } from "./ssrfGuard.js";

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
      // ЧЕРЕЗ safeFetch, а не голым fetch. URL сюда приходит от модели, и на машине
      // пользователя это ходило куда угодно: http://127.0.0.1:.../admin, облачные
      // метаданные на 169.254.169.254, любая внутренняя сеть — с возвратом тела ответа
      // обратно модели. То есть инструмент, продаваемый как проверка безопасности перед
      // оплатой, сам был вектором атаки на того, кто его поставил. Страж проверяет адрес
      // ПОСЛЕ разрешения имени и запрещает переходы по редиректам: без первого обходится
      // доменом, указывающим на 127.0.0.1, без второго — редиректом туда же.
      const res = await safeFetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
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
      // Заблокированный адрес — не сбой сети, и пользователь должен понимать разницу:
      // это отказ идти по адресу, а не «сервис недоступен».
      if (e instanceof SsrfBlocked) {
        out.error = `blocked: ${e.message}`;
        out.blocked = true;
        out.note = "This URL resolves to a private, loopback or link-local address. PulseFeed refuses to fetch it from your machine — that is how an untrusted URL turns an agent into a scanner of your own network.";
      } else {
        out.error = e?.name === "AbortError" ? "timeout" : e?.message;
      }
    }
    out.verdict = out.blocked ? "blocked — refused to fetch a private/loopback address" : out.valid ? "live — valid x402, safe to consider paying" : "avoid — no valid x402 challenge";
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

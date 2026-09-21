#!/usr/bin/env node
// PulseFeed MCP server — самодостаточный, зовёт публичные эндпоинты PulseFeed.
// Даёт агентам в Claude Desktop / Cursor / Cline инструменты для навигации по x402-экосистеме.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { safeFetch, SsrfBlocked } from "./ssrfGuard.js";
import { parseChallenge, decodePaymentRequiredHeader } from "./x402Challenge.js";

const BASE = process.env.PULSEFEED_URL || "https://pulsefeed.dev";

const server = new McpServer({ name: "pulsefeed-x402", version: "1.1.0" });

// Инструменты без аргументов: схема «объект без свойств и БЕЗ дополнительных» — как у живого сервера
// (пустая raw-shape давала бы {type:"object",properties:{}} без additionalProperties, и контракт расходился бы).
const NO_INPUT = z.object({}).strict();
const textOf = (j: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(j, null, 2) }] });
// Ошибка бэкенда обязана стать ОШИБКОЙ инструмента, а не тихими пустыми данными: 21.09.2026 контролёр
// воспроизвёл, как HTTP 503 превращался в «пакет чист». Проверяем статус и что тело — JSON-объект.
class BackendError extends Error { constructor(msg: string) { super(msg); this.name = "BackendError"; } }
const getJson = async (path: string): Promise<Record<string, any>> => {
  const r = await fetch(`${BASE}${path}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new BackendError(`PulseFeed answered HTTP ${r.status} for ${path}`);
  let j: unknown;
  try { j = await r.json(); } catch { throw new BackendError(`PulseFeed returned non-JSON for ${path}`); }
  if (!j || typeof j !== "object" || Array.isArray(j)) throw new BackendError(`PulseFeed returned an unexpected body for ${path}`);
  return j as Record<string, any>;
};
const errorOf = (e: unknown) => ({ isError: true as const, content: [{ type: "text" as const, text: `${e instanceof Error ? e.message : String(e)}. No verdict was produced; do not treat this as "clean".` }] });


server.registerTool(
  "x402_working_services",
  {
    title: "List live x402 services",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      "List x402 agent-payment services that are currently ALIVE and return a valid x402 challenge, ranked by trust score. A large share of listed x402 endpoints are dead or invalid (live figure at pulsefeed.dev/status.json) — use this to avoid paying broken or scam endpoints. Free.",
    inputSchema: NO_INPUT,
  },
  async () => { try { return textOf(await getJson("/status.json")); } catch (e) { return errorOf(e); } },
);

server.registerTool(
  "check_x402_endpoint",
  {
    title: "Check an x402 endpoint before paying",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      "Before paying an unknown x402 endpoint, check whether it is live and returns a valid x402 payment challenge. Returns liveness, price, network and a pay/avoid verdict. For full uptime + reputation, use PulseFeed's paid /trust API.",
    inputSchema: z.object({ url: z.string().describe("The x402 endpoint URL to verify") }).strict(),
  },
  async ({ url }) => {
    const out: any = { url, reachable: false, valid: false };
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 12000);
      // ЧЕРЕЗ safeFetch, а не голым fetch. URL сюда приходит от модели, и на машине
      // пользователя это ходило куда угодно: http://127.0.0.1:.../admin, облачные
      // метаданные на 169.254.169.254, любая внутренняя сеть — с возвратом тела ответа
      // обратно модели. Страж проверяет адрес ПОСЛЕ разрешения имени и запрещает
      // переходы по редиректам: без первого обходится доменом, указывающим на 127.0.0.1,
      // без второго — редиректом туда же.
      // Таймер снимается ПОСЛЕ чтения тела: сигнал общий для заголовков и тела (safeFetch объединяет его со своим).
      let res: Response;
      try {
        res = await safeFetch(url, { signal: ctrl.signal, timeoutMs: 12000, headers: { accept: "application/json" } });
        out.reachable = true;
        out.status = res.status;
        if (res.status === 402) {
          // v2 несёт челлендж в заголовке PAYMENT-REQUIRED (тело может быть пустым); v1 — в JSON-теле.
          // Заголовок читается первым; при его отсутствии или порче — тело. Источник вердикта фиксируется.
          const headerValue = res.headers.get("payment-required");
          const fromHeader = decodePaymentRequiredHeader(headerValue);
          let offers = parseChallenge(fromHeader), source: string | null = offers.length ? "PAYMENT-REQUIRED header" : null;
          let bodyError: string | null = null;
          if (!offers.length) {
            let b: unknown = null;
            try { b = await res.json(); } catch (e: any) { bodyError = ctrl.signal.aborted || e?.name === "AbortError" ? "timeout while reading the 402 body" : "402 body is not JSON"; }
            offers = parseChallenge(b); if (offers.length) source = "body";
          } else { res.body?.cancel().catch(() => {}); }
          out.valid = offers.length > 0;
          if (offers.length) { const a = offers[0]; out.price = a.amount; out.network = a.network; out.asset = a.asset; out.payTo = a.payTo; out.x402Version = a.version; out.offers = offers.length; out.challengeSource = source; out.resource = a.resource; }
          else {
            out.error = headerValue && !fromHeader ? "PAYMENT-REQUIRED header is not base64 JSON" + (bodyError ? `; ${bodyError}` : "; body carries no valid offer either")
              : bodyError ?? "402 without a valid x402 payment offer (x402Version 1 or 2 per @x402/core schema: v1 offers need scheme, network, maxAmountRequired, resource, description, payTo, maxTimeoutSeconds, asset; v2 needs a top-level resource.url and offers with scheme, CAIP-2 network, amount, asset, payTo, maxTimeoutSeconds)";
          }
        }
      } finally { clearTimeout(t); }
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
    // Дообогащение из непрерывного аудита PulseFeed: флаги скама/аномалий + trust score из кэша.
    try {
      const v: any = await getJson(`/verify?endpoint=${encodeURIComponent(url)}`);
      if (v && v.known) { out.trustScore = v.score; out.registryVerdict = v.verdict; out.knownFlags = v.flags; out.receiverStability = v.receiverStability; out.uptimePct = v.uptimePct; }
    } catch { /* кэш недоступен — живая проба выше уже дала вердикт */ }
    out.verdict = out.blocked ? "blocked — refused to fetch a private/loopback address" : out.valid ? "live — valid x402, safe to consider paying" : "avoid — no valid x402 challenge";
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
    inputSchema: NO_INPUT,
  },
  async () => {
    try { return textOf(await getJson("/")); } catch (e) { return errorOf(e); }
  },
);


// ---- Бесплатные data-тулы (обёртки публичных эндпоинтов PulseFeed) ----


server.registerTool(
  "x402_ecosystem_stats",
  { title: "x402 ecosystem health stats",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Live health of the entire x402 agent-payment ecosystem: how many endpoints are tracked/alive/dead, catalog accuracy audit (what share of 'healthy' listings actually work), scam-risk distribution and receiver-stability breakdown. Compact aggregates from PulseFeed's continuous independent audit. Free.", inputSchema: NO_INPUT },
  async () => {
    try {
      const j: any = await getJson("/status.json");
      if (!j.ecosystem || typeof j.ecosystem !== "object") throw new BackendError("status.json has no ecosystem block");
      return textOf({ ecosystem: j.ecosystem, catalogAudit: j.catalogAudit, security: j.security ? { riskByLevel: j.security.riskByLevel, flagCounts: j.security.flagCounts } : null, receiverStability: j.receiverStability, receiverOnchain: j.receiverOnchain, analytics: j.analytics });
    } catch (e) { return errorOf(e); }
  },
);

server.registerTool(
  "x402_leaderboard",
  { title: "x402 trust leaderboard",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Top x402 services ranked by PulseFeed Trust Score (0-100, open standard): the most reliable live agent-payment endpoints right now, with price and network. Use to pick a trustworthy service to pay. Free.", inputSchema: NO_INPUT },
  async () => {
    try {
      const j: any = await getJson("/status.json");
      if (!Array.isArray(j.topHealthy)) throw new BackendError("status.json has no topHealthy array");
      return textOf({ topHealthy: j.topHealthy, topProviders: j.topProviders, trustScoreSpec: `${BASE}/trust-score.json` });
    } catch (e) { return errorOf(e); }
  },
);

server.registerTool(
  "x402_incidents",
  { title: "Live x402 security incidents",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Live security incidents in the x402 economy caught by PulseFeed's detector: receiver hijacks (payTo swapped), bait-and-switch pricing, honeypots, unverified receivers, price gouging — each with an on-chain proof URL. Check before paying anything. Free.",
    inputSchema: z.object({ days: z.number().int().min(1).max(365).optional().describe("Window in days (default 30)") }).strict() },
  async ({ days }) => { try { return textOf(await getJson(`/incidents.json?days=${days ?? 30}&limit=50`)); } catch (e) { return errorOf(e); } },
);

server.registerTool(
  "x402_changes",
  { title: "Recent x402 ecosystem changes",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "What changed in the x402 ecosystem in the last 7 days: services that went dark, receiver (payTo) swaps — possible hijacks, price changes, recovered and newly-seen services. Derived from PulseFeed's compounding time-series (cannot be reconstructed after the fact). Free.",
    inputSchema: z.object({ days: z.number().int().min(1).max(365).optional().describe("Window in days (default 7)") }).strict() },
  async ({ days }) => { try { return textOf(await getJson(`/changes.json?days=${days ?? 7}&limit=100`)); } catch (e) { return errorOf(e); } },
);

server.registerTool(
  "mcp_drift_check",
  {
    title: "Has an MCP package changed since you trusted it?",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description:
      "The rug pull check. `mcp_check_server` answers whether a package is safe TODAY; this answers what CHANGED after it was adopted: an install script added in a later version (arbitrary code on `npm i` that was not there at review time), package ownership swapped, repository removed, package unpublished, build provenance lost. Pass your own dependency list to check it in one call. Derived from a daily external re-audit of the whole MCP package population — an event exists only because a snapshot from before it exists. Free.",
    inputSchema: z.object({
      packages: z.array(z.string()).max(200).optional().describe("npm package names to check, e.g. your installed MCP servers. Omit for the whole ecosystem feed."),
      days: z.number().int().min(1).max(365).optional().describe("Window in days (default 30)"),
    }).strict(),
  },
  async ({ packages, days }) => {
    try {
      const q = new URLSearchParams({ days: String(days ?? 30) });
      if (packages?.length) q.set("packages", packages.join(","));
      const j = await getJson(`/mcp/drift.json?${q.toString()}`);
      // `clean` вычисляется ТОЛЬКО из валидного массива ВАЛИДНЫХ событий: у каждого непустые строковые id и type
      // и разбираемая дата at. Иначе — нет вердикта: контролёр показал, что [null, {}] и затем {id:"",type:"",at:""}
      // давали clean на любой пакет.
      if (!Array.isArray(j.events)) throw new BackendError("drift feed has no events array");
      const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
      const bad = j.events.findIndex((e: any) => !e || typeof e !== "object" || !nonEmpty(e.id) || !nonEmpty(e.type) || !nonEmpty(e.at) || Number.isNaN(Date.parse(e.at)));
      if (bad >= 0) throw new BackendError(`drift feed event #${bad} is malformed`);
      if (packages?.length) {
        const seen = new Set(j.events.map((e: any) => e.id));
        j.clean = packages.filter(p => !seen.has(p));
        j.note = "`clean` means no recorded drift in this window. Use mcp_check_server for the package's current standing.";
      }
      return textOf(j);
    } catch (e) { return errorOf(e); }
  },
);

server.registerTool(
  "mcp_security_report",
  { title: "State of MCP security",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "State of MCP Security: how many audited MCP servers run an arbitrary install script on npm i, are abandoned, ship no repository or license — with day-over-day deltas and a sample of currently-flagged servers. From PulseFeed's daily MCP audit (950+ servers). Free.", inputSchema: NO_INPUT },
  async () => { try { const j: any = await getJson("/mcp-report.json"); return textOf({ current: j.current, deltas: j.deltas, riskySample: j.live ? j.live.riskySample : [] }); } catch (e) { return errorOf(e); } },
);

server.registerTool(
  "mcp_check_server",
  { title: "Audit an MCP server before installing",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "Before installing an MCP server, audit it by npm package name: does it run an install script (arbitrary code at npm i), is it abandoned, does it ship a repository/license, weekly downloads, provenance — verdict safe/caution/avoid. Free.", inputSchema: z.object({ package: z.string().describe("npm package name of the MCP server, e.g. @scope/name") }).strict() },
  async ({ package: pkg }) => { try { return textOf(await getJson(`/mcp/verify?package=${encodeURIComponent(pkg)}`)); } catch (e) { return errorOf(e); } },
);

server.registerTool(
  "x402_data_sample",
  { title: "Free sample of the trust dataset",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    description: "FREE sample of the PulseFeed Data API: top-10 live x402 services as FULL records (compounding payTo/price history, scam flags, on-chain receiver profile), top-10 MCP servers with full audit profile, and 3 live incidents. The full cross-domain dataset is GET /data/full ($1 via x402). Free.", inputSchema: NO_INPUT },
  async () => { try { return textOf(await getJson("/data/sample")); } catch (e) { return errorOf(e); } },
);

await server.connect(new StdioServerTransport());
console.error("pulsefeed-x402 MCP server running on stdio");

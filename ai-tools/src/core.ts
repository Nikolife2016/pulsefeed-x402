// pulsefeed-x402-ai-tools — core (framework-free, global fetch, Node 20+).
// Two tools for an AI agent on top of PulseFeed:
//   • verifyX402Endpoint — BEFORE paying an unfamiliar x402 endpoint, check whether it is safe
//     (live / valid / reputation / scam flags / on-chain receiver → pay or avoid).
//   • x402TrustCatalog   — find WORKING x402 services + the ecosystem risk map.
// The check is free (PulseFeed's cached /verify); the deep live check is the paid /trust.

export type Verdict = "safe" | "caution" | "avoid" | "unknown";

export interface VerifyResult {
  endpoint: string;
  known: boolean;
  live?: boolean;
  score?: number;
  verdict: Verdict;
  riskLevel?: string;
  flags?: string[];
  receiverProfile?: string | null;
  receiverStability?: string | null;
  priceUsd?: number | null;
  uptimePct?: number | null;
  cacheAgeHours?: number | null;
  advice?: string;
  /** Whether the paid live check is worth it, and why. */
  escalation?: { recommended: boolean; reason: string; liveCheck: string; priceUsd: number };
  ts?: string;
  /**
   * true when PulseFeed could not be consulted (HTTP error, timeout, non-JSON, unexpected body) or the
   * argument was not a URL. Then `verdict` is "unknown" ONLY because no verdict was produced — it is not
   * a statement about the endpoint. Agents must not treat a failed check as "safe" or as "not flagged".
   */
  checkFailed?: true;
  /** Why the check failed (present with checkFailed). */
  error?: string;
}

export interface PulsefeedOptions {
  /** PulseFeed base URL. Default https://pulsefeed.dev */
  apiUrl?: string;
  /** Request timeout, ms. Default 6000. */
  timeoutMs?: number;
  /** Custom fetch (tests / special environments). */
  fetchImpl?: (input: any, init?: any) => Promise<any>;
}

const DEFAULT_API = "https://pulsefeed.dev";
const VERDICTS: ReadonlySet<string> = new Set(["safe", "caution", "avoid", "unknown"]);

/** PulseFeed could not be consulted: HTTP error, timeout, non-JSON, or a body that is not what was asked for. */
export class PulseFeedUnavailableError extends Error {
  status?: number;
  constructor(msg: string, status?: number) { super(msg); this.name = "PulseFeedUnavailableError"; this.status = status; }
}

async function getJson(url: string, opts?: PulsefeedOptions): Promise<any> {
  const f = opts?.fetchImpl ?? (globalThis as any).fetch;
  if (!f) throw new PulseFeedUnavailableError("global fetch is not available — pass fetchImpl (Node 20+)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 6000);
  try {
    let r: any;
    try { r = await f(url, { signal: ctrl.signal, headers: { accept: "application/json" } }); }
    catch (e: any) { throw new PulseFeedUnavailableError(`PulseFeed request failed: ${e?.name === "AbortError" ? "timeout" : (e?.message ?? String(e))}`); }
    if (!r.ok) throw new PulseFeedUnavailableError(`PulseFeed HTTP ${r.status}`, r.status);
    let j: any;
    try { j = await r.json(); } catch { throw new PulseFeedUnavailableError("PulseFeed returned non-JSON", r.status); }
    if (!j || typeof j !== "object" || Array.isArray(j)) throw new PulseFeedUnavailableError("PulseFeed returned an unexpected body", r.status);
    return j;
  } finally {
    clearTimeout(timer);
  }
}

const failed = (endpoint: string, error: string): VerifyResult => ({
  endpoint, known: false, verdict: "unknown", checkFailed: true, error,
  advice: `PulseFeed check failed (${error}). No verdict was produced — do not treat this as safe; retry or use the live check GET /trust?endpoint=.`,
});

/**
 * Check an x402 endpoint BEFORE paying it (free, PulseFeed's cache).
 * Returns the verdict (pay / avoid), flags and an escalation hint towards the paid live check.
 * Never throws: a failed check comes back with `checkFailed: true` so the agent can tell "no verdict" from "unknown endpoint".
 */
export async function verifyX402Endpoint(endpoint: string, opts?: PulsefeedOptions): Promise<VerifyResult> {
  const api = (opts?.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  if (!endpoint || typeof endpoint !== "string" || !/^https?:\/\//i.test(endpoint)) {
    return failed(String(endpoint ?? ""), "an http(s) endpoint URL is required");
  }
  try {
    const j = await getJson(`${api}/verify?endpoint=${encodeURIComponent(endpoint)}`, opts);
    if (typeof j.known !== "boolean" || !VERDICTS.has(j.verdict)) return failed(endpoint, "PulseFeed returned an unexpected body");
    return j as VerifyResult;
  } catch (e: any) {
    return failed(endpoint, e?.message ?? String(e));
  }
}

/**
 * Catalog of WORKING x402 services + ecosystem summary (free).
 * Throws PulseFeedUnavailableError when PulseFeed cannot be consulted (the adapters surface it as a tool error).
 */
export async function x402TrustCatalog(opts?: PulsefeedOptions): Promise<any> {
  const api = (opts?.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  const j = await getJson(`${api}/status.json`, opts);
  // Форма проверяется, а не наличие ключа: {"topHealthy":"garbage"} или {"ecosystem":null} — не каталог.
  if (!Array.isArray(j.topHealthy) || !j.ecosystem || typeof j.ecosystem !== "object" || Array.isArray(j.ecosystem)) {
    throw new PulseFeedUnavailableError("PulseFeed status.json has an unexpected shape");
  }
  return {
    ecosystem: j.ecosystem,
    catalogAudit: j.catalogAudit,
    topHealthy: j.topHealthy,
    topProviders: j.topProviders,
    security: j.security?.riskByLevel ?? null,
    dataset: j.dataset ? { priceUsd: j.dataset.priceUsd, endpoint: j.dataset.endpoint, liveServices: j.dataset.liveServices } : null,
    note: "Live x402 services + ecosystem risk map by PulseFeed. Verify a specific endpoint before paying with verifyX402Endpoint.",
  };
}

/** Tool descriptions shared by the Vercel and LangChain adapters. */
export const TOOL_DESCRIPTIONS = {
  verify:
    "Check whether an x402 payment endpoint is SAFE TO PAY before paying it. Many listed x402 endpoints are dead, invalid or scams (live share at pulsefeed.dev/status.json). Returns a pay/avoid verdict with liveness, trust score, scam/anomaly flags, on-chain receiver profile and uptime. If the result has checkFailed: true, no verdict was produced — do not pay on that basis. Call this before sending any x402 payment to an unknown URL.",
  catalog:
    "List working (live, verified) x402 services and the ecosystem risk map from PulseFeed. Use when the agent needs to discover an x402 service that is safe to pay, or wants an overview of the x402 ecosystem's health.",
} as const;

// pulsefeed-x402-ai-tools — ядро (без завязки на фреймворк, global fetch, Node 18+).
// Даёт AI-агенту два инструмента над PulseFeed:
//   • verifyX402Endpoint — ПЕРЕД оплатой незнакомого x402-эндпоинта проверить, безопасен ли он
//     (жив/валиден/репутация/скам-флаги/on-chain получатель → pay/avoid). ~70% x402 мертвы.
//   • x402TrustCatalog   — найти РАБОЧИЕ x402-сервисы + карта рисков экосистемы.
// Проверка бесплатна (кэш PulseFeed /verify); глубокая live-проверка — платно в /trust.

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
  /** Подсказка: стоит ли платная live-проверка и почему. */
  escalation?: { recommended: boolean; reason: string; liveCheck: string; priceUsd: number };
  ts?: string;
}

export interface PulsefeedOptions {
  /** Базовый URL PulseFeed. По умолчанию https://pulsefeed.dev */
  apiUrl?: string;
  /** Таймаут запроса, мс. По умолчанию 6000. */
  timeoutMs?: number;
  /** Своя реализация fetch (для тестов/окружений). */
  fetchImpl?: (input: any, init?: any) => Promise<any>;
}

const DEFAULT_API = "https://pulsefeed.dev";

async function getJson(url: string, opts?: PulsefeedOptions): Promise<any> {
  const f = opts?.fetchImpl ?? (globalThis as any).fetch;
  if (!f) throw new Error("fetch недоступен — передай fetchImpl или используй Node 18+");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 6000);
  try {
    const r = await f(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`PulseFeed HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Проверить x402-эндпоинт ПЕРЕД оплатой (бесплатно, кэш PulseFeed).
 * Возвращает вердикт pay/avoid + флаги + подсказку об эскалации на платную live-проверку.
 */
export async function verifyX402Endpoint(endpoint: string, opts?: PulsefeedOptions): Promise<VerifyResult> {
  const api = (opts?.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  if (!endpoint || typeof endpoint !== "string") {
    return { endpoint: String(endpoint ?? ""), known: false, verdict: "unknown", advice: "Нужен URL эндпоинта." };
  }
  try {
    const j = await getJson(`${api}/verify?endpoint=${encodeURIComponent(endpoint)}`, opts);
    return j as VerifyResult;
  } catch (e: any) {
    return { endpoint, known: false, verdict: "unknown", advice: `PulseFeed недоступен: ${e?.message ?? e}` };
  }
}

/**
 * Каталог РАБОЧИХ x402-сервисов + сводка экосистемы (бесплатно).
 * Полезно, когда агенту надо НАЙТИ сервис, которому можно платить.
 */
export async function x402TrustCatalog(opts?: PulsefeedOptions): Promise<any> {
  const api = (opts?.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  const j = await getJson(`${api}/status.json`, opts);
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

/** Тексты описаний инструментов — общие для Vercel/LangChain адаптеров. */
export const TOOL_DESCRIPTIONS = {
  verify:
    "Check whether an x402 payment endpoint is SAFE TO PAY before paying it. ~70% of x402 endpoints are dead, invalid, or scams. Returns a pay/avoid verdict with liveness, trust score, scam/anomaly flags, on-chain receiver profile, and uptime. Call this before sending any x402 payment to an unknown URL.",
  catalog:
    "List working (live, verified) x402 services and the ecosystem risk map from PulseFeed. Use when the agent needs to discover an x402 service that is safe to pay, or wants an overview of the x402 ecosystem's health.",
} as const;

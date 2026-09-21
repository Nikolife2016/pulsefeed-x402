// pulsefeed-x402-guard — прослойка безопасности для x402-платежей агента.
// Оборачивает платёжный fetch: ПЕРЕД каждой оплатой проверяет эндпоинт у PulseFeed
// и блокирует мёртвые/скам/рискованные. Ноль зависимостей (global fetch, Node 18+).
//
// Единственная реализация — этот CommonJS-модуль (index.cts → dist/index.cjs). ESM-вход
// dist/index.js лишь реэкспортирует его: так класс PaymentBlockedError один на оба формата,
// и `instanceof` работает, даже если require и import встретились в одном процессе.
//
//   import { guardFetch } from "pulsefeed-x402-guard";
//   import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";   // x402 v2
//   const paying = wrapFetchWithPaymentFromConfig(fetch, { schemes: [...] });
//   const safe = guardFetch(paying);           // блокирует оплату мёртвых/скам-эндпоинтов
//   await safe("https://some-x402-service/api"); // проверено, потом оплачено

export type Verdict = "safe" | "caution" | "avoid" | "unknown";

export interface TrustVerdict {
  endpoint: string;
  known: boolean;
  live?: boolean;
  score?: number;
  verdict: Verdict;
  riskLevel?: string;
  flags?: string[];
  receiverProfile?: string | null;
  receiverStability?: string | null;
  advice?: string;
  note?: string;
}

type FetchLike = (input: any, init?: any) => Promise<any>;

export interface GuardOptions {
  /** Базовый URL PulseFeed. По умолчанию https://pulsefeed.dev */
  apiUrl?: string;
  /** Какие вердикты блокируют оплату. По умолчанию ["avoid"] (мёртвые/скам/high-risk). */
  block?: Verdict[];
  /** Что делать с эндпоинтом, которого нет в нашем индексе. По умолчанию "allow". */
  onUnknown?: "allow" | "block";
  /** Что делать, если PulseFeed недоступен (fail-open по умолчанию — не ломаем приложение). */
  onError?: "allow" | "block";
  /** Таймаут проверки, мс. По умолчанию 5000. */
  timeoutMs?: number;
  /** Колбэк на каждое решение (для логов/метрик). */
  onDecision?: (d: GuardDecision) => void;
  /** Своя реализация fetch (для тестов/окружений). */
  fetchImpl?: FetchLike;
}

export interface GuardDecision {
  url: string;
  decision: "allow" | "block";
  reason: string;
  trust: TrustVerdict;
}

export class PaymentBlockedError extends Error {
  url: string;
  trust: TrustVerdict;
  constructor(url: string, trust: TrustVerdict) {
    super(`PulseFeed blocked payment to ${url}: ${trust.verdict}${trust.flags?.length ? " [" + trust.flags.join(", ") + "]" : ""} — ${trust.advice ?? ""}`);
    this.name = "PaymentBlockedError";
    this.url = url;
    this.trust = trust;
  }
}

const DEFAULT_API = "https://pulsefeed.dev";
const VERDICTS: ReadonlySet<string> = new Set(["safe", "caution", "avoid", "unknown"]);

/** PulseFeed недоступен или ответил не тем: HTTP-ошибка, таймаут, не-JSON, чужая форма ответа. */
export class PulseFeedUnavailableError extends Error {
  status?: number;
  constructor(msg: string, status?: number) { super(msg); this.name = "PulseFeedUnavailableError"; this.status = status; }
}

function urlOf(input: any): string {
  if (typeof input === "string") return input;
  if (input && typeof input === "object") {
    if (typeof input.url === "string") return input.url;      // Request
    if (typeof input.href === "string") return input.href;    // URL
  }
  return String(input ?? "");
}

/** Лёгкая проверка эндпоинта через бесплатный PulseFeed /verify (кэш последнего краула). */
export async function verify(
  endpoint: string,
  opts: { apiUrl?: string; timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<TrustVerdict> {
  const api = (opts.apiUrl ?? DEFAULT_API).replace(/\/$/, "");
  const f: FetchLike = opts.fetchImpl ?? (globalThis as any).fetch;
  if (!f) throw new Error("global fetch недоступен — передайте fetchImpl (Node 18+ или полифилл)");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 5000);
  try {
    const r = await f(`${api}/verify?endpoint=${encodeURIComponent(endpoint)}`, {
      signal: ctrl.signal, headers: { accept: "application/json" },
    });
    // ⛔ Ошибка проверки ≠ вердикт «неизвестен». 21.09.2026 контролёр воспроизвёл: HTTP 503
    // возвращался как unknown, onError не срабатывал, и с onError:"block" оплата всё равно шла.
    // Теперь любая неисправность — исключение, которое guardFetch направляет в политику onError.
    if (!r.ok) throw new PulseFeedUnavailableError(`PulseFeed HTTP ${r.status}`, r.status);
    let j: any;
    try { j = await r.json(); } catch { throw new PulseFeedUnavailableError("PulseFeed returned non-JSON", r.status); }
    if (!j || typeof j !== "object" || typeof j.known !== "boolean" || !VERDICTS.has(j.verdict)) {
      throw new PulseFeedUnavailableError("PulseFeed returned an unexpected body", r.status);
    }
    return j as TrustVerdict;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Оборачивает платёжный fetch проверкой доверия ПЕРЕД оплатой.
 * Блокирует запрос (PaymentBlockedError) к рискованным эндпоинтам по политике.
 */
export function guardFetch(innerFetch: FetchLike, opts: GuardOptions = {}): FetchLike {
  const block = new Set<Verdict>(opts.block ?? ["avoid"]);
  const onUnknown = opts.onUnknown ?? "allow";
  const onError = opts.onError ?? "allow";

  return async function guardedFetch(input: any, init?: any): Promise<any> {
    const url = urlOf(input);
    let trust: TrustVerdict;
    try {
      trust = await verify(url, { apiUrl: opts.apiUrl, timeoutMs: opts.timeoutMs, fetchImpl: opts.fetchImpl });
    } catch (e) {
      // Неисправность проверки решается ТОЛЬКО политикой onError: "allow" — платёж идёт (fail-open),
      // "block" — не идёт. onUnknown и block здесь не участвуют: они про исправный ответ PulseFeed.
      trust = { endpoint: url, known: false, verdict: "unknown", advice: `PulseFeed unavailable: ${e instanceof Error ? e.message : String(e)}` };
      const d: GuardDecision = { url, decision: onError === "block" ? "block" : "allow", reason: "verify-error", trust };
      opts.onDecision?.(d);
      if (d.decision === "block") throw new PaymentBlockedError(url, trust);
      return innerFetch(input, init);
    }

    // Сначала вердикт, потом «известность»: блокирующий вердикт блокирует независимо от known
    // (контролёр показал, что {known:false, verdict:"avoid"} проходил через onUnknown="allow"),
    // а block:["unknown"] действует и на корректный неизвестный эндпоинт.
    let decision: "allow" | "block" = "allow";
    let reason = "ok";
    if (block.has(trust.verdict)) {
      decision = "block";
      reason = `verdict:${trust.verdict}`;
    } else if (!trust.known) {
      decision = onUnknown === "block" ? "block" : "allow";
      reason = "unknown";
    }

    opts.onDecision?.({ url, decision, reason, trust });
    if (decision === "block") throw new PaymentBlockedError(url, trust);
    return innerFetch(input, init);
  };
}

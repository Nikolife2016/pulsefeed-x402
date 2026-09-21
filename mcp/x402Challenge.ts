// Разбор x402-ответа 402. «Валидный челлендж» — не «есть первый элемент accepts» (контролёр показал, что
// {accepts:[{}]} и {accepts:["garbage"]} объявлялись valid:true), и не «есть несколько полей» (раунд 5:
// x402Version 999, v2-тело с v1-полями, без maxTimeoutSeconds и сумма 1e21 проходили). Проверяется версия
// и обязательная для НЕЁ структура предложения — по схемам протокола:
//   v1: scheme, network, maxAmountRequired (строка из цифр), resource (строка), payTo (EVM-адрес), asset,
//       maxTimeoutSeconds (целое > 0);
//   v2: scheme, network, amount (строка из цифр), resource { url }, payTo, asset, maxTimeoutSeconds.
// Иные версии — невалидны. Сумма принимается только как десятичная строка из цифр (число — только если это
// безопасное целое; 1e21 таковым не является).
export interface X402Offer { scheme: string; network: string; payTo: string; asset: string; amount: string; maxTimeoutSeconds: number; resource: string; version: 1 | 2 }

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;
const amountOf = (v: unknown): string | null => {
  if (typeof v === "string") return /^\d+$/.test(v) ? v : null;
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;
  return null;
};
const timeoutOf = (v: unknown): number | null => typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null;

export function parseOffer(a: unknown, version: 1 | 2): X402Offer | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const o = a as Record<string, unknown>;
  if (!nonEmpty(o.scheme) || !nonEmpty(o.network) || !nonEmpty(o.asset)) return null;
  if (typeof o.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.payTo)) return null;
  const maxTimeoutSeconds = timeoutOf(o.maxTimeoutSeconds);
  if (maxTimeoutSeconds === null) return null;
  let amount: string | null, resource: string | null = null;
  if (version === 1) {
    amount = amountOf(o.maxAmountRequired);
    resource = nonEmpty(o.resource) ? o.resource : null;
  } else {
    amount = amountOf(o.amount);
    const r = o.resource as Record<string, unknown> | undefined;
    resource = r && typeof r === "object" && !Array.isArray(r) && nonEmpty(r.url) ? (r.url as string) : null;
  }
  if (amount === null || resource === null) return null;
  return { scheme: o.scheme, network: o.network, payTo: o.payTo, asset: o.asset, amount, maxTimeoutSeconds, resource, version };
}

/** Из тела 402 — список валидных предложений (пустой список = невалидный челлендж, включая неподдерживаемую версию). */
export function parseChallenge(body: unknown): X402Offer[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const b = body as Record<string, unknown>;
  const version = b.x402Version === 1 ? 1 : b.x402Version === 2 ? 2 : null;
  if (version === null || !Array.isArray(b.accepts)) return [];
  return b.accepts.map(a => parseOffer(a, version)).filter((x): x is X402Offer => x !== null);
}

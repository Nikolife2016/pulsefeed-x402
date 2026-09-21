// Разбор x402-челленджа (ответ 402). «Валидный» = соответствует схеме протокола для своей версии — та же
// структура, что PaymentRequiredSchema в @x402/core 2.26 (в приёмке сверяется с ней на каждой фикстуре):
//   v1: { x402Version: 1, accepts: [ { scheme, network, maxAmountRequired, resource (строка URL), description
//         (строка, может быть пустой), mimeType?, payTo, maxTimeoutSeconds (> 0), asset, extra? } ] }
//   v2: { x402Version: 2, resource: { url, … } НА ВЕРХНЕМ УРОВНЕ, accepts: [ { scheme, network (CAIP-2 с «:»),
//         amount, asset, payTo, maxTimeoutSeconds (> 0), extra? } ] }
//   v2 передаёт челлендж в заголовке PAYMENT-REQUIRED (base64 JSON); тело может быть пустым.
// История: {accepts:[{}]} и ["garbage"] объявлялись валидными; затем x402Version 999, v2 с v1-полями, без
// maxTimeoutSeconds и 1e21 проходили; затем resource у v2 искался внутри предложения, а v1 без description
// принимался, заголовок PAYMENT-REQUIRED игнорировался (раунды 4–6 контролёра).
// Сверх схемы SDK — два правила PulseFeed, отмечены (*): сумма — десятичная строка из цифр (атомарные единицы
// схемы exact; SDK требует лишь непустую строку), и для EVM-сетей payTo — 0x + 40 hex.
export interface X402Offer { scheme: string; network: string; payTo: string; asset: string; amount: string; maxTimeoutSeconds: number; resource: string; version: 1 | 2 }

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const amountOf = (v: unknown): string | null => {
  if (typeof v === "string") return /^\d+$/.test(v) ? v : null;                                   // (*)
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? String(v) : null;        // (*) число — только безопасное целое
  return null;
};
const EVM_V1 = new Set(["base", "base-sepolia", "ethereum", "sepolia", "polygon", "polygon-amoy", "arbitrum", "optimism", "avalanche", "avalanche-fuji", "iotex", "sei", "sei-testnet"]);
const evmNetwork = (network: string, version: 1 | 2) => version === 2 ? /^eip155:/i.test(network) : EVM_V1.has(network.toLowerCase());
const payToOk = (v: unknown, network: string, version: 1 | 2) => nonEmpty(v) && (!evmNetwork(network, version) || /^0x[0-9a-fA-F]{40}$/.test(v));   // (*)
const timeoutOf = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;

export function parseOfferV1(a: unknown): X402Offer | null {
  if (!isObj(a)) return null;
  if (!nonEmpty(a.scheme) || !nonEmpty(a.network) || !nonEmpty(a.asset) || !nonEmpty(a.resource)) return null;
  if (typeof a.description !== "string") return null;
  if (a.mimeType !== undefined && typeof a.mimeType !== "string") return null;
  if (!payToOk(a.payTo, a.network, 1)) return null;
  const maxTimeoutSeconds = timeoutOf(a.maxTimeoutSeconds); if (maxTimeoutSeconds === null) return null;
  const amount = amountOf(a.maxAmountRequired); if (amount === null) return null;
  return { scheme: a.scheme, network: a.network, payTo: a.payTo as string, asset: a.asset, amount, maxTimeoutSeconds, resource: a.resource, version: 1 };
}

export function parseOfferV2(a: unknown, resource: string): X402Offer | null {
  if (!isObj(a)) return null;
  if (!nonEmpty(a.scheme) || !nonEmpty(a.asset)) return null;
  if (!nonEmpty(a.network) || a.network.length < 3 || !a.network.includes(":")) return null;      // CAIP-2
  if (!payToOk(a.payTo, a.network, 2)) return null;
  const maxTimeoutSeconds = timeoutOf(a.maxTimeoutSeconds); if (maxTimeoutSeconds === null) return null;
  const amount = amountOf(a.amount); if (amount === null) return null;
  return { scheme: a.scheme, network: a.network, payTo: a.payTo as string, asset: a.asset, amount, maxTimeoutSeconds, resource, version: 2 };
}

/**
 * Из тела челленджа — список предложений, если челлендж валиден ЦЕЛИКОМ; иначе пустой список.
 * Как у схемы SDK: один невалидный элемент accepts делает невалидным весь челлендж (не «отбросить мусор и
 * взять валидное»: клиент не должен платить по документу, часть которого не разбирается).
 */
export function parseChallenge(body: unknown): X402Offer[] {
  if (!isObj(body) || !Array.isArray(body.accepts) || body.accepts.length === 0) return [];
  let offers: (X402Offer | null)[];
  if (body.x402Version === 1) offers = body.accepts.map(parseOfferV1);
  else if (body.x402Version === 2) {
    if (!isObj(body.resource) || !nonEmpty(body.resource.url)) return [];
    const url = body.resource.url;
    offers = body.accepts.map(a => parseOfferV2(a, url));
  } else return [];
  return offers.every((x): x is X402Offer => x !== null) ? offers : [];
}

/** Заголовок PAYMENT-REQUIRED (v2): base64 JSON → объект; иначе null. */
export function decodePaymentRequiredHeader(value: string | null | undefined): unknown | null {
  if (!value || typeof value !== "string") return null;
  try { const j = JSON.parse(Buffer.from(value.trim(), "base64").toString("utf8")); return isObj(j) ? j : null; } catch { return null; }
}

// Разбор x402-челленджа (ответ 402). «Валидный» = принимается PaymentRequiredSchema из @x402/core — эталонной
// схемой протокола (зависимость пакета; версия закреплена lockfile). Своей копии схемы нет: контролёр показал,
// что «зеркало» расходилось с эталоном на необязательных полях (extra:"garbage", extensions:[], resource.tags:42,
// error:{…}, числовая сумма) и объявляло такие документы валидными.
//   v1: { x402Version: 1, accepts: [ { scheme, network, maxAmountRequired, resource (URL-строка), description,
//         mimeType?, outputSchema?, payTo, maxTimeoutSeconds (> 0), asset, extra? } ] }
//   v2: { x402Version: 2, resource: { url, … } на верхнем уровне, accepts: [ { scheme, network (CAIP-2), amount,
//         asset, payTo, maxTimeoutSeconds (> 0), extra? } ], extensions? }
//   v2 передаёт челлендж в заголовке PAYMENT-REQUIRED (base64 JSON); тело может быть пустым.
// Сверх схемы SDK — два правила PulseFeed, отмечены (*): сумма — десятичная строка из цифр (атомарные единицы
// схемы exact; SDK требует лишь непустую строку) и для EVM-сетей payTo — 0x + 40 hex. Одно невалидное
// предложение делает невалидным весь челлендж (так у схемы; клиент не должен платить по документу, часть
// которого не разбирается).
import { PaymentRequiredSchema } from "@x402/core/schemas";

export interface X402Offer { scheme: string; network: string; payTo: string; asset: string; amount: string; maxTimeoutSeconds: number; resource: string; version: 1 | 2 }

const EVM_V1 = new Set(["base", "base-sepolia", "ethereum", "sepolia", "polygon", "polygon-amoy", "arbitrum", "optimism", "avalanche", "avalanche-fuji", "iotex", "sei", "sei-testnet"]);
const evmNetwork = (network: string, version: 1 | 2) => version === 2 ? /^eip155:/i.test(network) : EVM_V1.has(network.toLowerCase());
const pulsefeedRules = (o: X402Offer) => /^\d+$/.test(o.amount) && (!evmNetwork(o.network, o.version) || /^0x[0-9a-fA-F]{40}$/.test(o.payTo));   // (*)

/** Из тела челленджа — список предложений, если челлендж валиден целиком по схеме SDK и правилам (*); иначе []. */
export function parseChallenge(body: unknown): X402Offer[] {
  const r = PaymentRequiredSchema.safeParse(body);
  if (!r.success) return [];
  const d = r.data;
  const offers: X402Offer[] = d.x402Version === 1
    ? d.accepts.map(a => ({ scheme: a.scheme, network: a.network, payTo: a.payTo, asset: a.asset, amount: a.maxAmountRequired, maxTimeoutSeconds: a.maxTimeoutSeconds, resource: a.resource, version: 1 as const }))
    : d.accepts.map(a => ({ scheme: a.scheme, network: a.network, payTo: a.payTo, asset: a.asset, amount: a.amount, maxTimeoutSeconds: a.maxTimeoutSeconds, resource: d.resource.url, version: 2 as const }));
  return offers.every(pulsefeedRules) ? offers : [];
}

/** Заголовок PAYMENT-REQUIRED (v2): base64 JSON → объект; иначе null. */
export function decodePaymentRequiredHeader(value: string | null | undefined): unknown | null {
  if (!value || typeof value !== "string") return null;
  try { const j = JSON.parse(Buffer.from(value.trim(), "base64").toString("utf8")); return j && typeof j === "object" && !Array.isArray(j) ? j : null; } catch { return null; }
}

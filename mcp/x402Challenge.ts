// Разбор x402-ответа 402: «валидный челлендж» — не «есть первый элемент accepts» (контролёр показал, что
// {accepts:[{}]} и {accepts:["garbage"]} объявлялись valid:true с вердиктом «safe to consider paying»),
// а платёжное предложение с полным набором полей: scheme, network, payTo (EVM-адрес), asset и целая сумма
// (v1: maxAmountRequired; v2: amount). Первое валидное предложение и даёт цену/сеть/актив/получателя.
export interface X402Offer { scheme: string; network: string; payTo: string; asset: string; amount: string; version: 1 | 2 }

const isDigits = (v: unknown) => typeof v === "string" ? /^\d+$/.test(v) : (typeof v === "number" && Number.isInteger(v) && v >= 0);

export function parseOffer(a: unknown): X402Offer | null {
  if (!a || typeof a !== "object" || Array.isArray(a)) return null;
  const o = a as Record<string, unknown>;
  if (typeof o.scheme !== "string" || !o.scheme || typeof o.network !== "string" || !o.network) return null;
  if (typeof o.payTo !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(o.payTo)) return null;
  if (typeof o.asset !== "string" || !o.asset) return null;
  const v2 = o.amount !== undefined, v1 = o.maxAmountRequired !== undefined;
  const amount = v2 ? o.amount : o.maxAmountRequired;
  if (!(v1 || v2) || !isDigits(amount)) return null;
  return { scheme: o.scheme, network: o.network, payTo: o.payTo, asset: o.asset, amount: String(amount), version: v2 ? 2 : 1 };
}

/** Из тела 402 — список валидных предложений (пустой список = невалидный челлендж). */
export function parseChallenge(body: unknown): X402Offer[] {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  const accepts = (body as Record<string, unknown>).accepts;
  if (!Array.isArray(accepts)) return [];
  return accepts.map(parseOffer).filter((x): x is X402Offer => x !== null);
}

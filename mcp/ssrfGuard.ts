// Защита от SSRF. Мы по своей природе ходим по ЧУЖИМ URL: краул берёт адреса из внешних
// каталогов (402index/Bazaar — кто угодно может там залистить сервис), а платный /trust
// пробит URL, присланный клиентом. Без проверок это превращает сервер в сканер внутренней
// сети: злоумышленник листит «сервис» с адресом http://127.0.0.1:… или http://169.254.169.254/
// и читает результат в ответе (статус/ошибка отличают открытый порт от закрытого).
//
// Защищаемся до соединения: только http(s), запрет приватных/loopback/link-local диапазонов
// ПОСЛЕ резолва DNS (иначе обходится доменом, указывающим на 127.0.0.1), и ручная проверка
// каждого редиректа (fetch по умолчанию идёт по 302 куда угодно — классический обход).
import { lookup } from "node:dns/promises";
import net from "node:net";

export class SsrfBlocked extends Error {
  constructor(reason: string) { super(`blocked: ${reason}`); this.name = "SsrfBlocked"; }
}

function ipv4Blocked(ip: string): string | null {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return "невалидный IPv4";
  const [a, b] = p;
  if (a === 0) return "0.0.0.0/8";
  if (a === 10) return "10/8 (частная сеть)";
  if (a === 127) return "127/8 (loopback)";
  if (a === 169 && b === 254) return "169.254/16 (link-local / cloud metadata)";
  if (a === 172 && b >= 16 && b <= 31) return "172.16/12 (частная сеть)";
  if (a === 192 && b === 168) return "192.168/16 (частная сеть)";
  if (a === 100 && b >= 64 && b <= 127) return "100.64/10 (CGNAT)";
  if (a === 192 && b === 0) return "192.0/16 (спец. назначение)";
  if (a >= 224) return ">=224/4 (multicast/reserved)";
  return null;
}

/** Развернуть IPv6 в 16 байт (или null, если это не IPv6). Понимает «::», точечный IPv4-хвост и zone id. */
export function ipv6Bytes(ip: string): Uint8Array | null {
  let s = ip.toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  if (!net.isIPv6(s)) return null;
  // Точечный IPv4-хвост (::ffff:127.0.0.1, ::127.0.0.1, 64:ff9b::127.0.0.1) → два hex-слова.
  const tail = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (tail) {
    const p = tail.slice(1, 5).map(Number);
    s = s.slice(0, tail.index) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - rest.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const words = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest].map(w => parseInt(w, 16));
  if (words.length !== 8 || words.some(w => Number.isNaN(w) || w < 0 || w > 0xffff)) return null;
  const out = new Uint8Array(16);
  words.forEach((w, i) => { out[2 * i] = w >> 8; out[2 * i + 1] = w & 0xff; });
  return out;
}

const dotted = (b: Uint8Array, at: number) => `${b[at]}.${b[at + 1]}.${b[at + 2]}.${b[at + 3]}`;

function ipv6Blocked(ip: string): string | null {
  const b = ipv6Bytes(ip);
  if (!b) return "невалидный IPv6";
  const zeroTo = (n: number) => b.slice(0, n).every(x => x === 0);
  if (zeroTo(15) && (b[15] === 0 || b[15] === 1)) return b[15] ? "IPv6 loopback (::1)" : "IPv6 unspecified (::)";
  // Встроенный IPv4 проверяем как IPv4 — в ЛЮБОЙ записи (контролёр обошёл точечную проверку через ::ffff:7f00:1):
  //   ::ffff:a.b.c.d (IPv4-mapped), ::a.b.c.d (IPv4-compatible), 64:ff9b::a.b.c.d (NAT64), 2002:AABB:CCDD:: (6to4).
  if (zeroTo(10) && b[10] === 0xff && b[11] === 0xff) { const r = ipv4Blocked(dotted(b, 12)); return r ? `IPv4-mapped ${dotted(b, 12)}: ${r}` : null; }
  if (zeroTo(12)) { const r = ipv4Blocked(dotted(b, 12)); return r ? `IPv4-compatible ${dotted(b, 12)}: ${r}` : "IPv4-compatible IPv6 (устаревшая форма)"; }
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && b.slice(4, 12).every(x => x === 0)) { const r = ipv4Blocked(dotted(b, 12)); return r ? `NAT64 ${dotted(b, 12)}: ${r}` : null; }
  if (b[0] === 0x20 && b[1] === 0x02) { const r = ipv4Blocked(dotted(b, 2)); return r ? `6to4 ${dotted(b, 2)}: ${r}` : null; }
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return "IPv6 link-local (fe80::/10)";
  if ((b[0] & 0xfe) === 0xfc) return "IPv6 unique-local (fc00::/7)";
  if (b[0] === 0xff) return "IPv6 multicast (ff00::/8)";
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return "Teredo (2001::/32) — встроенные IPv4 скрыты";
  return null;
}

export function ipBlockedReason(ip: string): string | null {
  return net.isIPv4(ip) ? ipv4Blocked(ip) : net.isIPv6(ip) ? ipv6Blocked(ip) : "неизвестный формат IP";
}

// Проверяем один URL: схема + все IP, в которые резолвится хост.
export async function assertSafeUrl(raw: string): Promise<URL> {
  let u: URL;
  try { u = new URL(raw); } catch { throw new SsrfBlocked("невалидный URL"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new SsrfBlocked(`схема ${u.protocol}`);

  const host = u.hostname.replace(/^\[|\]$/g, "");
  // Литеральный IP — проверяем сразу, без DNS.
  if (net.isIP(host)) {
    const r = ipBlockedReason(host);
    if (r) throw new SsrfBlocked(r);
    return u;
  }
  if (/^localhost$/i.test(host) || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local")) {
    throw new SsrfBlocked(`внутреннее имя ${host}`);
  }
  let addrs: { address: string }[];
  try { addrs = await lookup(host, { all: true }); }
  catch { throw new SsrfBlocked(`DNS не резолвится: ${host}`); }
  if (!addrs.length) throw new SsrfBlocked(`нет A/AAAA: ${host}`);
  for (const a of addrs) {
    const r = ipBlockedReason(a.address);
    if (r) throw new SsrfBlocked(`${host} → ${a.address}: ${r}`);
  }
  return u;
}

// fetch с проверкой КАЖДОГО редиректа (fetch сам по 302 ушёл бы куда угодно).
// Таймаут действует на ВСЁ: заголовки и чтение тела (контролёр показал: таймер снимался при заголовках, сигнал
// вызывающего подменялся, и сервер с незавершающимся телом держал инструмент бесконечно). Сигнал вызывающего
// пересылается в наш; таймер снимается, когда тело дочитано (поток обёрнут), при отмене снаружи или при ошибке —
// он держит процесс ровно столько, сколько идёт чтение, и не дольше timeoutMs.
export async function safeFetch(
  raw: string,
  init: RequestInit & { timeoutMs?: number } = {},
  maxRedirects = 3,
): Promise<Response> {
  const { timeoutMs = 12000, signal: outer, ...rest } = init;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(new Error(`timeout after ${timeoutMs} ms`)), timeoutMs);
  const done = () => clearTimeout(timer);
  if (outer) {
    if (outer.aborted) { done(); ctrl.abort(outer.reason); }
    else outer.addEventListener("abort", () => { done(); ctrl.abort(outer.reason); }, { once: true });
  }
  const signal = ctrl.signal;
  try {
    let current = raw;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertSafeUrl(current);
      if (signal.aborted) throw new Error("aborted before request");
      const res = await fetch(current, { ...rest, redirect: "manual", signal });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) { done(); return res; }
        if (hop === maxRedirects) throw new SsrfBlocked("слишком много редиректов");
        current = new URL(loc, current).toString();
        continue;
      }
      return boundedBody(res, done);
    }
    throw new SsrfBlocked("слишком много редиректов");
  } catch (e) { done(); throw e; }
}

// Ответ, чьё тело при дочитывании снимает таймер. Без тела (204/HEAD) или без потока (моки) — таймер
// остаётся до срабатывания или до отмены снаружи.
function boundedBody(res: Response, done: () => void): Response {
  const body: any = (res as any).body;
  if (body === null) { done(); return res; }
  if (!body || typeof body.pipeThrough !== "function" || typeof TransformStream === "undefined") return res;
  const stream = body.pipeThrough(new TransformStream({ flush() { done(); } }));
  return new Response(stream, { status: res.status, statusText: res.statusText, headers: res.headers });
}

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

function ipv6Blocked(ip: string): string | null {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s === "::1" || s === "::") return "IPv6 loopback/unspecified";
  if (s.startsWith("fe80")) return "IPv6 link-local";
  if (/^f[cd]/.test(s)) return "IPv6 unique-local (fc00::/7)";
  // IPv4-mapped: ::ffff:127.0.0.1
  const m = s.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (m) return ipv4Blocked(m[1]);
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
export async function safeFetch(
  raw: string,
  init: RequestInit & { timeoutMs?: number } = {},
  maxRedirects = 3,
): Promise<Response> {
  const { timeoutMs = 12000, ...rest } = init;
  let current = raw;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertSafeUrl(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(current, { ...rest, redirect: "manual", signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get("location");
      if (!loc) return res;
      if (hop === maxRedirects) throw new SsrfBlocked("слишком много редиректов");
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new SsrfBlocked("слишком много редиректов");
}

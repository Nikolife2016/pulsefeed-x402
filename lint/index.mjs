#!/usr/bin/env node
// x402-payable — is this endpoint actually payable?
//
// "Returned a 402" and "is a payable product" are not the same claim. This runs the checks
// that separate them, against any URL, with no dependencies and no calls to any service of
// ours. Every check exists because someone (us, first) got it wrong in production:
// https://pulsefeed.dev/correction
//
// Exit codes: 0 payable · 1 not payable · 2 could not be determined · 3 usage error.

const SPEC_SCHEMES = new Set(["exact", "upto", "auth-capture", "batch-settlement"]);
const DEFAULT_CLIENT_SCHEMES = new Set(["exact"]);   // what plain x402-fetch settles
const CAP_SCHEMES = new Set(["upto", "auth-capture"]); // `amount` is a ceiling, not a price

// Canonical USDC per chain, with decimals stated explicitly. USDC is 6 decimals nearly
// everywhere and 18 on BSC — assuming 6 across the board is a 10^12 error.
const USDC = {
  "eip155:1":     { addr: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", decimals: 6,  name: "Ethereum" },
  "eip155:10":    { addr: "0x0b2c639c533813f4aa9d7837caf62653d097ff85", decimals: 6,  name: "Optimism" },
  "eip155:56":    { addr: "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", decimals: 18, name: "BSC" },
  "eip155:137":   { addr: "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", decimals: 6,  name: "Polygon" },
  "eip155:8453":  { addr: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", decimals: 6,  name: "Base" },
  "eip155:42161": { addr: "0xaf88d065e77c8cc2239327c5edb3a432268e5831", decimals: 6,  name: "Arbitrum" },
  "eip155:43114": { addr: "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e", decimals: 6,  name: "Avalanche" },
  // Testnet USDC is listed so the report can say "canonical, but on a testnet" rather than
  // the false "not canonical USDC" — a wrong reason for a right verdict is still wrong.
  "eip155:84532": { addr: "0x036cbd53842c5426634e7929541ec2318f3dcf7e", decimals: 6,  name: "Base Sepolia", testnet: true },
};
const ALIAS = { base: "eip155:8453", "base-sepolia": "eip155:84532", ethereum: "eip155:1", mainnet: "eip155:1",
  polygon: "eip155:137", arbitrum: "eip155:42161", optimism: "eip155:10", avalanche: "eip155:43114", bsc: "eip155:56" };
const TESTNETS = new Set(["eip155:84532", "eip155:11155111", "eip155:80002", "eip155:421614", "eip155:11155420",
  "solana:devnet", "solana:testnet",
  // Solana names networks by a truncated genesis hash — "devnet" never appears in the string.
  "solana:etwtrabzayq6imfeykouru166vu2xqa1", "solana:4uhcvjyu9pjkvqys88urdiswhxscky3z"]);

const canonNet = n => { if (!n) return undefined; const s = String(n).toLowerCase().trim(); return ALIAS[s] ?? s; };
const isTestnet = n => { const c = canonNet(n); return !!c && (TESTNETS.has(c) || /sepolia|goerli|devnet|testnet/i.test(String(n))); };

// base64 / base64url / bare JSON. Duplicate headers arrive joined by ", " — try the whole
// thing and each part, because a naive decode of the join yields silent garbage.
function decodeChallenge(raw) {
  const parts = raw.includes(", ") ? [raw, ...raw.split(", ")] : [raw];
  for (const p of parts) {
    const s = p.trim().replace(/^"|"$/g, "");
    for (const cand of [s, s.replace(/-/g, "+").replace(/_/g, "/")]) {
      try {
        const json = Buffer.from(cand, "base64").toString("utf8");
        if (json.trim().startsWith("{")) { const o = JSON.parse(json); if (o?.accepts) return o; }
      } catch { /* next encoding */ }
    }
    try { const o = JSON.parse(s); if (o?.accepts) return o; } catch { /* next part */ }
  }
  return null;
}

const norm = a => a && typeof a === "object" ? {
  scheme: typeof a.scheme === "string" ? a.scheme : undefined,
  network: a.network,
  asset: a.asset ?? a.currency,
  payTo: typeof (a.payTo ?? a.recipient) === "string" ? (a.payTo ?? a.recipient) : undefined,
  amount: a.amount ?? a.maxAmountRequired,
} : null;

async function readLimited(res, maxBytes) {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return null;
  try { const t = await res.text(); return t.length > maxBytes ? null : JSON.parse(t); } catch { return null; }
}

export async function lint(url, { timeoutMs = 15000 } = {}) {
  const checks = [];
  const add = (id, ok, msg, level = "fail") => checks.push({ id, ok, level: ok ? "pass" : level, msg });

  let u;
  try { u = new URL(url); } catch { return { url, verdict: "error", checks: [{ id: "url", ok: false, level: "fail", msg: "not a URL" }] }; }
  if (u.protocol !== "http:" && u.protocol !== "https:")
    return { url, verdict: "error", checks: [{ id: "url", ok: false, level: "fail", msg: `unsupported scheme ${u.protocol}` }] };

  // 6. Unfilled path placeholder — a string copied out of documentation, not a resource.
  const placeholder = /:[A-Za-z_][A-Za-z0-9_]*(\/|$)|\{[A-Za-z_][A-Za-z0-9_]*\}|\/example(\/|$)/.test(u.pathname);
  add("placeholder-url", !placeholder,
    placeholder ? `path contains an unfilled placeholder (${u.pathname}) — this is a documentation string, not an addressable resource`
                : "no unfilled path placeholders", "fail");

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try { res = await fetch(url, { headers: { accept: "application/json" }, signal: ctrl.signal }); }
  catch (e) { clearTimeout(timer); add("reachable", false, `request failed: ${e?.name === "AbortError" ? "timeout" : e?.message}`);
    return { url, verdict: "unknown", checks }; }
  clearTimeout(timer);

  add("reachable", true, `HTTP ${res.status}`);
  if (res.status !== 402) { add("http-402", false, `expected 402, got ${res.status}`); return { url, verdict: "not-payable", checks }; }
  add("http-402", true, "returns 402 Payment Required");

  // 1. Read BOTH sources. v2 moved the challenge into the header and made the body a server
  // implementation detail; a body-only reader reports live v2 services as broken.
  const body = await readLimited(res, 256 * 1024);
  const hdrRaw = res.headers.get("payment-required") ?? res.headers.get("x-payment-required");
  const hdr = hdrRaw ? decodeChallenge(hdrRaw) : null;
  const bodyAcc = Array.isArray(body?.accepts) ? body.accepts : null;
  const hdrAcc = Array.isArray(hdr?.accepts) ? hdr.accepts : null;

  if (!bodyAcc && !hdrAcc) { add("challenge", false, "402 carries no payment requirements in either the body or the PAYMENT-REQUIRED header");
    return { url, verdict: "not-payable", checks }; }
  add("challenge", true, hdrAcc && bodyAcc ? "requirements present in both the header and the body"
    : hdrAcc ? "requirements in the PAYMENT-REQUIRED header (x402 v2)" : "requirements in the response body (x402 v1)");

  // 2. When both are present and disagree, a v2 client pays what the HEADER says — which is
  // not what a body-only check displays.
  if (bodyAcc && hdrAcc) {
    const b = norm(bodyAcc.find(a => a?.scheme === "exact") ?? bodyAcc[0]);
    const h = norm(hdrAcc.find(a => a?.scheme === "exact") ?? hdrAcc[0]);
    const diff = [];
    if (b?.payTo && h?.payTo && b.payTo.toLowerCase() !== h.payTo.toLowerCase()) diff.push("payTo");
    if (b?.amount != null && h?.amount != null && String(b.amount) !== String(h.amount)) diff.push("amount");
    if (b?.asset && h?.asset && String(b.asset).toLowerCase() !== String(h.asset).toLowerCase()) diff.push("asset");
    if (b?.network && h?.network && canonNet(b.network) !== canonNet(h.network)) diff.push("network");
    add("body-header-agree", diff.length === 0,
      diff.length ? `body and header disagree on ${diff.join(", ")} — a v2 client pays the HEADER; verify there, not in the body`
                  : "body and header state the same terms");
  }

  const offers = (hdrAcc ?? bodyAcc).map(norm).filter(Boolean);
  const chosen = offers.find(o => o.scheme && DEFAULT_CLIENT_SCHEMES.has(o.scheme))
              ?? offers.find(o => o.scheme && SPEC_SCHEMES.has(o.scheme)) ?? offers[0];

  // 3. Scheme against the spec. Outside it, settlement bypasses the facilitator and funds
  // are not held in escrow. In-spec-but-not-exact is a client compatibility matter.
  const noScheme = offers.every(o => !o.scheme);
  const inSpec = noScheme || offers.some(o => o.scheme && SPEC_SCHEMES.has(o.scheme));
  add("scheme-in-spec", inSpec,
    inSpec ? `scheme ${chosen?.scheme ?? "(unspecified, treated as exact/v1)"} is in the x402 spec`
           : `scheme "${chosen?.scheme}" is not in the x402 spec (exact / upto / auth-capture / batch-settlement) — settlement does not go through a facilitator and funds are not in escrow`);
  const exactAvailable = noScheme || offers.some(o => o.scheme && DEFAULT_CLIENT_SCHEMES.has(o.scheme));
  if (inSpec) add("default-client-can-pay", exactAvailable,
    exactAvailable ? "a default x402-fetch client can settle this"
                   : `only "${chosen?.scheme}" is offered — in spec, but a default x402-fetch client cannot settle it without work`, "warn");

  // 5. Mainnet. A testnet sandbox priced in dollars is not a product.
  const allTest = offers.length ? offers.every(o => isTestnet(o.network)) : isTestnet(chosen?.network);
  add("mainnet", !allTest, allTest ? `all offers are on a test network (${offers.map(o => o.network).join(", ")}) — the dollar price is not real`
    : `network ${chosen?.network ?? "?"}`);

  // Receiver sanity.
  const payTo = chosen?.payTo;
  const zeroish = payTo && /^0x0{39}[01]$/i.test(payTo);
  add("receiver", !!payTo && !zeroish,
    !payTo ? "no payTo in the challenge — there is nobody to pay"
      : zeroish ? `payTo is the zero address (${payTo}) — a payment sent here cannot reach anyone` : `payTo ${payTo}`);

  // 4 + 7. Is `amount` a price or a ceiling, and what are the token's decimals on this chain?
  const isCap = chosen?.scheme && CAP_SCHEMES.has(chosen.scheme);
  const net = canonNet(chosen?.network);
  const known = net && USDC[net];
  const assetIsUsdc = known && chosen?.asset && String(chosen.asset).toLowerCase() === known.addr;
  if (chosen?.amount != null) {
    const raw = String(chosen.amount).trim();
    if (!/^\d+$/.test(raw)) {
      add("amount-parses", false, `amount "${raw}" is not a decimal integer — hex or exponent notation silently misreads`);
    } else if (assetIsUsdc) {
      const usd = Number(raw) / 10 ** known.decimals;
      add("amount-parses", true, isCap
        ? `authorization ceiling up to $${usd} USDC on ${known.name} (${known.decimals} decimals) — this is a maximum, NOT the per-call price`
        : `price $${usd} USDC on ${known.name} (${known.decimals} decimals)`);
      if (isCap) add("amount-is-a-price", false,
        `scheme "${chosen.scheme}" states a maximum draw, not a per-call cost — do not compare this number against other services' prices`, "warn");
    } else {
      add("amount-parses", true, `amount ${raw} in asset ${chosen?.asset ?? "?"} — not canonical USDC for ${chosen?.network ?? "this network"}, so decimals are unknown and the value cannot be read as dollars`);
      add("asset-known", false, `asset ${chosen?.asset ?? "(none)"} is not the canonical USDC on ${chosen?.network ?? "?"} — check what token you are being asked for`, "warn");
    }
  }

  const hardFail = checks.some(c => !c.ok && c.level === "fail");
  return { url, verdict: hardFail ? "not-payable" : "payable", offers: offers.length, checks };
}

// ── CLI ─────────────────────────────────────────────────────────────────────
// Определяем "запущен напрямую" честно, через realpath. Сравнение имён файлов ломалось под
// npx: он подставляет свой шим (node_modules/.bin/x402-payable), имя которого не совпадает с
// index.mjs, и CLI молча не запускался — пакет публиковался «рабочим», а на деле печатал
// пустоту. Шим — симлинк на этот файл, поэтому realpath их сводит.
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
const isMain = (() => {
  if (!process.argv[1]) return false;
  try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; }
  catch { return false; }
})();
if (isMain) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  // В логах CI должно быть видно, какой версией получен вердикт — иначе непонятно, чему
  // верить, когда проверка меняется.
  if (args.includes("--version") || args.includes("-v")) {
    const { readFileSync } = await import("node:fs");
    const here = new URL("./package.json", import.meta.url);
    console.log(JSON.parse(readFileSync(here, "utf8")).version);
    process.exit(0);
  }
  const url = args.find(a => !a.startsWith("--"));
  if (!url) {
    console.error(`x402-payable — is this endpoint actually payable?

  npx x402-payable <url> [--json]

Checks the things that make an endpoint return a valid 402 while still not being something
you can buy: v1/v2 challenge location, body/header disagreement, payment scheme against the
x402 spec, ceilings misread as prices, testnets priced in dollars, documentation placeholders,
and per-chain token decimals.

Runs standalone — no account, no API key, no call to any third-party service.
Exit: 0 payable · 1 not payable · 2 undetermined · 3 usage.
Why each check exists: https://pulsefeed.dev/correction`);
    process.exit(3);
  }
  const r = await lint(url);
  if (json) { console.log(JSON.stringify(r, null, 2)); }
  else {
    const mark = c => c.ok ? "  ok  " : c.level === "warn" ? " warn " : " FAIL ";
    console.log(`\n  ${r.url}`);
    for (const c of r.checks) console.log(`${mark(c)} ${c.id.padEnd(22)} ${c.msg}`);
    const v = r.verdict;
    console.log(`\n  → ${v === "payable" ? "PAYABLE" : v === "not-payable" ? "NOT PAYABLE" : v.toUpperCase()}` +
      (r.offers ? `  (${r.offers} payment option${r.offers > 1 ? "s" : ""} offered)` : "") + "\n");
  }
  process.exit(r.verdict === "payable" ? 0 : r.verdict === "not-payable" ? 1 : 2);
}

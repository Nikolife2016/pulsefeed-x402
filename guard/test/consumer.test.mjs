// Приёмка guard как ЗАВИСИМОСТИ: npm pack → установка тарбола в чистый каталог без dev-зависимостей
// и без lifecycle-скриптов → потребители на CommonJS, ESM, TypeScript (NodeNext, .cts и .mts) →
// поведение: блокирует avoid без вызова платёжного fetch, пропускает safe, один класс ошибки
// на оба формата, пример из README на @x402/fetch v2 исполняется.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(new URL("..", import.meta.url).pathname);
const tgz = process.env.PKG_TGZ || (() => {
  const out = JSON.parse(execFileSync("npm", ["pack", "--json", "--silent"], { cwd: PKG, encoding: "utf8" }));
  return join(PKG, out[0].filename);
})();
const dir = mkdtempSync(join(tmpdir(), "pf-guard-consumer-"));
execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" });
execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tgz, "@x402/fetch@^2.26.0", "typescript@^5.9"], { cwd: dir, stdio: "ignore" });
const run = (file, args = []) => execFileSync(process.execPath, [file, ...args], { cwd: dir, encoding: "utf8", timeout: 60_000 });

// Мок PulseFeed /verify: avoid для одного домена, safe для другого, не отвечает — для третьего.
const MOCK = `
const mockFetch = async (url) => {
  const u = String(url);
  if (u.includes("verify?endpoint=") && u.includes("scam.example")) return { ok: true, json: async () => ({ endpoint: "x", known: true, verdict: "avoid", flags: ["honeypot"], advice: "do not pay" }) };
  if (u.includes("verify?endpoint=") && u.includes("good.example")) return { ok: true, json: async () => ({ endpoint: "x", known: true, verdict: "safe", score: 95 }) };
  if (u.includes("verify?endpoint=")) throw new Error("PulseFeed down");
  return { ok: true, status: 200, json: async () => ({ paid: true, url: u }) };
};
`;

test("тарбол содержит ровно четыре файла dist и ничего лишнего", () => {
  const list = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean);
  for (const f of ["package/dist/index.cjs", "package/dist/index.d.cts", "package/dist/index.js", "package/dist/index.d.ts"]) assert.ok(list.includes(f), "нет " + f);
  assert.ok(!list.some(f => /node_modules|\.env|\.pem|src\//.test(f)), "лишние файлы: " + list.join(","));
});

test("CommonJS: require даёт три экспорта, avoid блокируется БЕЗ вызова платёжного fetch, safe проходит", () => {
  writeFileSync(join(dir, "consumer.cjs"), `${MOCK}
const g = require("pulsefeed-x402-guard");
const keys = Object.keys(g).sort(); if (JSON.stringify(keys) !== JSON.stringify(["PaymentBlockedError","guardFetch","verify"])) throw new Error("exports: " + keys);
let paid = 0; const paying = async (u) => { paid++; return { ok: true, json: async () => ({ paid: true }) }; };
const decisions = [];
const safe = g.guardFetch(paying, { fetchImpl: mockFetch, onDecision: d => decisions.push(d.decision + ":" + d.reason) });
(async () => {
  let blocked = false; try { await safe("https://scam.example/api"); } catch (e) { blocked = e instanceof g.PaymentBlockedError && e.name === "PaymentBlockedError"; }
  if (!blocked) throw new Error("avoid не заблокирован классом PaymentBlockedError");
  if (paid !== 0) throw new Error("платёжный fetch вызван при блокировке");
  const r = await safe("https://good.example/api"); if (!(await r.json()).paid || paid !== 1) throw new Error("safe не прошёл");
  const v = await g.verify("https://good.example/api", { fetchImpl: mockFetch }); if (v.verdict !== "safe") throw new Error("verify");
  const r2 = await safe("https://unknown.example/api"); if (paid !== 2) throw new Error("fail-open при недоступном PulseFeed не сработал");
  console.log("CJS OK " + decisions.join(","));
})().catch(e => { console.error(e); process.exit(1); });`);
  const out = run("consumer.cjs");
  assert.match(out, /CJS OK block:verdict:avoid,allow:ok,allow:unknown/);
});

test("ESM: import даёт те же экспорты; onError=block блокирует при недоступном PulseFeed", () => {
  writeFileSync(join(dir, "consumer.mjs"), `${MOCK}
import { guardFetch, verify, PaymentBlockedError } from "pulsefeed-x402-guard";
if (typeof guardFetch !== "function" || typeof verify !== "function" || typeof PaymentBlockedError !== "function") throw new Error("exports");
const safe = guardFetch(async () => ({ ok: true }), { fetchImpl: mockFetch, onError: "block" });
let blocked = false; try { await safe("https://unknown.example/api"); } catch (e) { blocked = e instanceof PaymentBlockedError; }
if (!blocked) throw new Error("onError=block не сработал");
console.log("ESM OK");`);
  assert.match(run("consumer.mjs"), /ESM OK/);
});

test("один класс ошибки на оба формата: instanceof через границу require/import", () => {
  writeFileSync(join(dir, "both.mjs"), `${MOCK}
import { createRequire } from "node:module";
import { guardFetch, PaymentBlockedError as EsmErr } from "pulsefeed-x402-guard";
const { PaymentBlockedError: CjsErr } = createRequire(import.meta.url)("pulsefeed-x402-guard");
if (EsmErr !== CjsErr) throw new Error("два разных класса PaymentBlockedError");
const safe = guardFetch(async () => ({ ok: true }), { fetchImpl: mockFetch });
try { await safe("https://scam.example/api"); } catch (e) { if (!(e instanceof CjsErr) || !(e instanceof EsmErr)) throw new Error("instanceof не проходит через границу"); }
console.log("IDENTITY OK");`);
  assert.match(run("both.mjs"), /IDENTITY OK/);
});

test("TypeScript NodeNext: потребители .cts и .mts типизируются (tsc --noEmit)", () => {
  writeFileSync(join(dir, "c.cts"), `import { guardFetch, PaymentBlockedError, type TrustVerdict } from "pulsefeed-x402-guard";
const safe = guardFetch(fetch, { block: ["avoid", "caution"] }); const t: TrustVerdict = { endpoint: "x", known: false, verdict: "unknown" }; const e = new PaymentBlockedError("u", t); export { safe, e };`);
  writeFileSync(join(dir, "m.mts"), `import { verify, type GuardOptions } from "pulsefeed-x402-guard";
const o: GuardOptions = { onUnknown: "block" }; export const p = verify("https://x.example", { timeoutMs: 100 }); export { o };`);
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, target: "ES2022", lib: ["ES2022", "DOM"] }, files: ["c.cts", "m.mts"] }));
  execFileSync(join(dir, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" });
});

test("пример README на @x402/fetch v2 исполняется: guardFetch оборачивает wrapFetchWithPayment", () => {
  writeFileSync(join(dir, "readme.mjs"), `${MOCK}
import { guardFetch, PaymentBlockedError } from "pulsefeed-x402-guard";
import { wrapFetchWithPayment, x402Client } from "@x402/fetch";
if (typeof wrapFetchWithPayment !== "function" || typeof x402Client !== "function") throw new Error("@x402/fetch v2 API отсутствует");
// Клиент без схем: платить не умеет, но обёртка строится — этого достаточно, чтобы доказать состав примера.
const paying = wrapFetchWithPayment(mockFetch, new x402Client());
const safe = guardFetch(paying, { fetchImpl: mockFetch });
let blocked = false; try { await safe("https://scam.example/api"); } catch (e) { blocked = e instanceof PaymentBlockedError; }
if (!blocked) throw new Error("пример: avoid не заблокирован до оплаты");
const r = await safe("https://good.example/api"); if (!r.ok) throw new Error("пример: safe не прошёл");
console.log("README EXAMPLE OK");`);
  assert.match(run("readme.mjs"), /README EXAMPLE OK/);
});

test("отрицательный контроль: README не ссылается на deprecated x402-fetch v1", () => {
  const readme = readFileSync(join(PKG, "README.md"), "utf8");
  assert.ok(/import \{ .*\} from "x402-fetch"/.test('import { wrapFetchWithPayment } from "x402-fetch"'), "контроль детектора");
  assert.ok(!/from "x402-fetch"/.test(readme), "README всё ещё импортирует x402-fetch");
  assert.ok(/@x402\/fetch/.test(readme), "README не упоминает @x402/fetch");
});

process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); if (!process.env.PKG_TGZ && existsSync(tgz)) rmSync(tgz); } catch {} });

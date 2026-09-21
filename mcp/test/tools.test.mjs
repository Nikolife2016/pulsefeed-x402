// Приёмочный тест ПОСТАВЛЯЕМОГО пакета (не исходника): npm pack → установка тарбола в чистый каталог
// без dev-зависимостей и без lifecycle-скриптов → запуск bin по stdio → initialize, tools/list, tools/call.
// 06.08.2026 в npm ушла версия с тремя инструментами из одиннадцати: исходник был урезан, и ничто перед
// публикацией не проверяло, что поставляется. Имена — не контракт: контракт — имена + схемы + поведение,
// поэтому схемы сверяются с датированным снимком живого сервера, а поведение — вызовами, включая
// отказ бэкенда (локальный сервер, отвечающий 503), при котором инструмент обязан вернуть ошибку.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync, appendFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JSONRPCMessageSchema } from "@modelcontextprotocol/sdk/types.js";
import { PaymentRequiredSchema } from "@x402/core/schemas";
import { createServer as createTcpServer } from "node:net";

const PKG = resolve(new URL("..", import.meta.url).pathname);
const SNAPSHOT = JSON.parse(readFileSync(new URL("./live-tools.snapshot.json", import.meta.url), "utf8"));
const LIVE = process.env.PULSEFEED_URL || "https://pulsefeed.dev";
// PKG_TEST_LOG=<файл>: полный JSON-RPC-обмен каждого сеанса (запросы, ответы, stderr, код выхода) — журнал приёмки.
const LOG = process.env.PKG_TEST_LOG;
const logSession = (rec) => { if (LOG) appendFileSync(LOG, JSON.stringify(rec) + "\n"); };

const tgz = process.env.PKG_TGZ || (() => {
  const out = JSON.parse(execFileSync("npm", ["pack", "--json", "--silent"], { cwd: PKG, encoding: "utf8" }));
  return join(PKG, out[0].filename);
})();
const consumer = mkdtempSync(join(tmpdir(), "pf-mcp-consumer-"));
execFileSync("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tgz], { cwd: consumer, stdio: "ignore" });
const bin = join(consumer, "node_modules", ".bin", "pulsefeed-x402-mcp");

const INIT = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acceptance", version: "0" } } };
const READY = { jsonrpc: "2.0", method: "notifications/initialized" };

/** Один сеанс stdio: отправить запросы, дождаться ответов на все id, закрыть stdin, вернуть сообщения и код выхода. */
function session(requests, { backend = LIVE, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, [], { cwd: consumer, env: { ...process.env, PULSEFEED_URL: backend } });
    let out = "", err = "", settled = false;
    const ids = new Set(requests.filter(r => r.id != null).map(r => r.id));
    const timer = setTimeout(() => { if (!settled) { settled = true; clearInterval(poll); p.kill("SIGKILL"); reject(new Error("timeout; stdout so far: " + out.slice(0, 300))); } }, timeoutMs);
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    p.on("close", code => { if (settled) return; settled = true; clearTimeout(timer); clearInterval(poll);
      const msgs = out.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { __junk: l }; } });
      logSession({ at: new Date().toISOString(), backend, requests, responses: msgs, stderr: err, exitCode: code });
      resolve({ msgs, code, err }); });
    for (const r of requests) p.stdin.write(JSON.stringify(r) + "\n");
    const poll = setInterval(() => {
      const got = new Set(out.split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l).id]; } catch { return []; } }));
      if ([...ids].every(i => got.has(i))) { clearInterval(poll); p.stdin.end(); }
    }, 100);
  });
}
// Настоящее сообщение JSON-RPC 2.0 — по схеме самого MCP SDK (JSONRPCMessageSchema), а не по своей аппроксимации:
// контролёр показал, что {id:9, error:"garbage"} и {method:"notice", params:42} проходили самодельную проверку.
const isRpc = m => !!m && typeof m === "object" && !("__junk" in m) && JSONRPCMessageSchema.safeParse(m).success;
const strict = (s, ids) => {
  assert.equal(s.code, 0, "код выхода сервера не 0: " + s.code + " stderr: " + s.err.slice(0, 200));
  const junk = s.msgs.filter(m => !isRpc(m));
  assert.equal(junk.length, 0, "в stdout не-JSON-RPC: " + JSON.stringify(junk.slice(0, 2)));
  const init = s.msgs.find(m => m.id === 1); assert.ok(init?.result?.serverInfo?.name === "pulsefeed-x402", "initialize не вернул serverInfo: " + JSON.stringify(init).slice(0, 160));
  for (const id of ids) { const m = s.msgs.find(x => x.id === id); assert.ok(m, "нет ответа на id " + id); assert.ok(!m.error, `RPC-ошибка на id ${id}: ` + JSON.stringify(m.error)); }
};
const body = (s, id) => { const r = s.msgs.find(m => m.id === id).result; return { r, j: r.isError ? null : JSON.parse(r.content[0].text) }; };
// Схема сравнивается ЦЕЛИКОМ (типы, границы, items, required, additionalProperties); убираются только $schema
// (артефакт сериализатора, не ограничение) и текст description у свойств.
const deep = v => JSON.stringify(v, (k, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort()) : x);
const canon = sc => { const c = JSON.parse(JSON.stringify(sc ?? {})); delete c.$schema;
  for (const v of Object.values(c.properties ?? {})) delete v.description; return deep(c); };
const sameSchema = (a, b) => canon(a) === canon(b);

test("тарбол: РОВНО dist/{index,ssrfGuard,x402Challenge}.js, README, CHANGELOG, LICENSE и package.json — ничего лишнего", () => {
  const list = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
  const nonDist = list.filter(f => !f.startsWith("package/dist/"));
  assert.deepEqual(nonDist, ["package/CHANGELOG.md", "package/LICENSE", "package/README.md", "package/package.json"]);
  assert.deepEqual(list.filter(f => f.startsWith("package/dist/")), ["package/dist/index.js", "package/dist/ssrfGuard.js", "package/dist/x402Challenge.js"]);
});

test("tools/list установленного пакета: имена И схемы == снимок живого сервера; stdout чистый; выход 0", async () => {
  const s = await session([INIT, READY, { jsonrpc: "2.0", id: 2, method: "tools/list" }]);
  strict(s, [2]);
  const list = s.msgs.find(m => m.id === 2).result.tools;
  const names = list.map(t => t.name).sort();
  assert.equal(new Set(names).size, names.length, "дубликаты имён");
  assert.deepEqual(names, SNAPSHOT.tools, `набор инструментов не совпал со снимком от ${SNAPSHOT.takenAt}`);
  assert.equal(names.length, 11);
  for (const t of list) {
    assert.ok(typeof t.description === "string" && t.description.length > 40, `у ${t.name} нет описания`);
    assert.ok(sameSchema(t.inputSchema, SNAPSHOT.inputSchemas[t.name]), `схема ${t.name} расходится со снимком:\n  pkg  ${canon(t.inputSchema)}\n  live ${canon(SNAPSHOT.inputSchemas[t.name])}`);
  }
});

// Детерминированно, без зависимости от скользящего окна живой ленты: локальный бэкенд отдаёт одно событие.
const withBackend = async (handler, fn) => { const srv = createServer(handler); await new Promise(r => srv.listen(0, "127.0.0.1", r)); try { return await fn(`http://127.0.0.1:${srv.address().port}`); } finally { srv.close(); } };
const json = (res, code, obj) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(obj)); };
const EVENT = { eventId: "eb9c6cb717f2e882", id: "@modelcontextprotocol/sdk", type: "maintainer_changed", at: "2026-09-18T01:33:01.592Z", severity: "high", headline: "x" };

test("mcp_drift_check: пакет с событием — в events и НЕ в clean; пакет без событий — в clean; requested как передан", () => withBackend(
  (req, res) => json(res, 200, { generated: "t", windowDays: 30, total: 1, events: [EVENT], requested: ["@modelcontextprotocol/sdk", "quiet-pkg"] }),
  async backend => {
    const s = await session([INIT, READY, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: ["@modelcontextprotocol/sdk", "quiet-pkg"], days: 30 } } }], { backend });
    strict(s, [3]);
    const { r, j } = body(s, 3); assert.ok(!r.isError, "инструмент вернул ошибку: " + r.content?.[0]?.text);
    assert.deepEqual(j.events, [EVENT]); assert.deepEqual(j.requested, ["@modelcontextprotocol/sdk", "quiet-pkg"]);
    assert.deepEqual(j.clean, ["quiet-pkg"]);
  }));

test("отрицательный контроль: событие с пустыми строками {id:'',type:'',at:''} или с неразбираемой датой → ошибка, не clean", async () => {
  for (const ev of [{ id: "", type: "", at: "" }, { id: "x", type: "maintainer_changed", at: "not a date" }, { id: " ", type: "t", at: "2026-09-18T00:00:00Z" }]) {
    await withBackend((req, res) => json(res, 200, { events: [ev], requested: ["risky-package"] }), async backend => {
      const s = await session([INIT, READY, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: ["risky-package"] } } }], { backend });
      strict(s, []); const r = s.msgs.find(m => m.id === 3).result; assert.ok(r?.isError && /malformed/.test(r.content[0].text), "прошло: " + JSON.stringify(ev) + " → " + JSON.stringify(r).slice(0, 200));
    });
  }
});

test("пустая лента (events: []) — корректный ответ: все запрошенные пакеты clean, без isError", () => withBackend(
  (req, res) => json(res, 200, { generated: "t", windowDays: 30, total: 0, events: [], requested: ["a", "b"] }),
  async backend => {
    const s = await session([INIT, READY, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: ["a", "b"] } } }], { backend });
    strict(s, [3]); const { r, j } = body(s, 3); assert.ok(!r.isError); assert.deepEqual(j.events, []); assert.deepEqual(j.clean, ["a", "b"]);
  }));

test("отрицательный контроль: повреждённые события ([null, {}]) → ошибка, не clean", () => withBackend(
  (req, res) => json(res, 200, { events: [null, {}], requested: ["risky-package"] }),
  async backend => {
    const s = await session([INIT, READY, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: ["risky-package"] } } }], { backend });
    strict(s, []); const r = s.msgs.find(m => m.id === 3).result; assert.ok(r?.isError && /malformed/.test(r.content[0].text), JSON.stringify(r).slice(0, 200));
  }));

// Фикстуры бэкенда для ДЕТЕРМИНИРОВАННОЙ проверки всех 11 инструментов: каждый ответ известен заранее,
// и у каждого инструмента проверяется ИМЕННО его выход (значения из фикстур, преобразования, поля), а не «непустой JSON».
const FX = {
  status: { ecosystem: { total: 100, live: 40 }, catalogAudit: { checked: 10 }, security: { riskByLevel: { high: 1 }, flagCounts: { honeypot: 2 } }, receiverStability: { stable: 3 }, receiverOnchain: { known: 4 }, analytics: { a: 1 }, topHealthy: [{ url: "https://good.example/api", score: 95 }], topProviders: [{ provider: "good.example" }] },
  root: { name: "PulseFeed", protocol: "x402", tools: [{ path: "/pulse", price: "$0.01" }] },
  incidents: { days: 5, incidents: [{ kind: "payTo_hijack", url: "https://scam.example" }] },
  changes: { days: 3, changes: [{ kind: "new", url: "https://new.example" }] },
  drift: { generated: "t", windowDays: 30, total: 1, events: [EVENT], requested: ["@modelcontextprotocol/sdk", "quiet-pkg"] },
  report: { current: { packages: 24000 }, deltas: { d: 1 }, live: { riskySample: [{ id: "bad-pkg" }] } },
  verify: { package: "mcp-remote", verdict: "safe", score: 90 },
  sample: { rows: [{ url: "https://good.example/api" }] },
  endpointVerify: { endpoint: "http://127.0.0.1:1/x", known: true, score: 12, verdict: "avoid", flags: ["dead"], receiverStability: "none", uptimePct: 0 },
};
const fixtures = (req, res) => {
  const u = new URL(req.url, "http://x"); const p = u.pathname;
  if (p === "/") return json(res, 200, FX.root);
  if (p === "/status.json") return json(res, 200, FX.status);
  if (p === "/incidents.json") return json(res, 200, { ...FX.incidents, q: Object.fromEntries(u.searchParams) });
  if (p === "/changes.json") return json(res, 200, { ...FX.changes, q: Object.fromEntries(u.searchParams) });
  if (p === "/mcp/drift.json") return json(res, 200, { ...FX.drift, q: Object.fromEntries(u.searchParams) });
  if (p === "/mcp-report.json") return json(res, 200, FX.report);
  if (p === "/mcp/verify") return json(res, 200, { ...FX.verify, q: Object.fromEntries(u.searchParams) });
  if (p === "/data/sample") return json(res, 200, FX.sample);
  if (p === "/verify") return json(res, 200, FX.endpointVerify);
  json(res, 404, { error: "unexpected path " + p });
};
test("все 11 инструментов на фикстурах локального бэкенда: детерминированный выход каждого инструмента", () => withBackend(fixtures, async backend => {
  const args = { check_x402_endpoint: { url: "http://127.0.0.1:1/x" }, mcp_check_server: { package: "mcp-remote" }, mcp_drift_check: { packages: ["@modelcontextprotocol/sdk", "quiet-pkg"], days: 30 }, x402_changes: { days: 3 }, x402_incidents: { days: 5 } };
  const reqs = SNAPSHOT.tools.map((name, i) => ({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name, arguments: args[name] ?? {} } }));
  const s = await session([INIT, READY, ...reqs], { backend, timeoutMs: 120_000 });
  strict(s, reqs.map(r => r.id));
  const out = {}; for (const [i, name] of SNAPSHOT.tools.entries()) { const r = s.msgs.find(m => m.id === 100 + i).result; assert.ok(!r.isError, `${name}: isError — ${r.content?.[0]?.text?.slice(0, 160)}`); out[name] = JSON.parse(r.content[0].text); }
  assert.deepEqual(out.x402_working_services, FX.status);
  assert.deepEqual(out.pulsefeed_products, FX.root);
  assert.deepEqual(out.x402_ecosystem_stats, { ecosystem: FX.status.ecosystem, catalogAudit: FX.status.catalogAudit, security: FX.status.security, receiverStability: FX.status.receiverStability, receiverOnchain: FX.status.receiverOnchain, analytics: FX.status.analytics });
  assert.deepEqual(out.x402_leaderboard, { topHealthy: FX.status.topHealthy, topProviders: FX.status.topProviders, trustScoreSpec: `${backend}/trust-score.json` });
  assert.deepEqual(out.x402_incidents, { ...FX.incidents, q: { days: "5", limit: "50" } });
  assert.deepEqual(out.x402_changes, { ...FX.changes, q: { days: "3", limit: "100" } });
  assert.deepEqual(out.mcp_drift_check, { ...FX.drift, q: { days: "30", packages: "@modelcontextprotocol/sdk,quiet-pkg" }, clean: ["quiet-pkg"], note: out.mcp_drift_check.note });
  assert.match(out.mcp_drift_check.note, /no recorded drift/);
  assert.deepEqual(out.mcp_security_report, { current: FX.report.current, deltas: FX.report.deltas, riskySample: FX.report.live.riskySample });
  assert.deepEqual(out.mcp_check_server, { ...FX.verify, q: { package: "mcp-remote" } });
  assert.deepEqual(out.x402_data_sample, FX.sample);
  // check_x402_endpoint: loopback-адрес обязан быть ОТКАЗАН стражем SSRF (детерминированно, без сети),
  // обогащение из /verify при этом приходит с бэкенда.
  const c = out.check_x402_endpoint;
  assert.equal(c.url, "http://127.0.0.1:1/x"); assert.equal(c.blocked, true); assert.equal(c.reachable, false); assert.equal(c.valid, false);
  assert.match(c.verdict, /^blocked/); assert.match(c.error, /^blocked:/);
  assert.equal(c.trustScore, 12); assert.equal(c.registryVerdict, "avoid"); assert.deepEqual(c.knownFlags, ["dead"]);
  assert.equal(c.fullReputation, `${backend}/trust?endpoint=${encodeURIComponent("http://127.0.0.1:1/x")} (paid: adds uptime + reputation history)`);
}));

test("отрицательный контроль: бэкенд-фикстуры с испорченным status.json → x402_ecosystem_stats и x402_leaderboard дают isError", () => withBackend(
  (req, res) => json(res, 200, { hello: "world" }),
  async backend => {
    const s = await session([INIT, READY, { jsonrpc: "2.0", id: 21, method: "tools/call", params: { name: "x402_ecosystem_stats", arguments: {} } }, { jsonrpc: "2.0", id: 22, method: "tools/call", params: { name: "x402_leaderboard", arguments: {} } }], { backend });
    strict(s, []); for (const id of [21, 22]) { const r = s.msgs.find(m => m.id === id).result; assert.ok(r?.isError && /No verdict was produced/.test(r.content[0].text), JSON.stringify(r).slice(0, 200)); }
  }));

test("живой сервер, smoke: все 11 инструментов отвечают без isError, drift-лента разбирается (пустая лента допустима)", async () => {
  const args = { check_x402_endpoint: { url: "https://pulsefeed.dev/whales" }, mcp_check_server: { package: "mcp-remote" }, mcp_drift_check: { days: 7 }, x402_changes: { days: 7 }, x402_incidents: { days: 7 } };
  const reqs = SNAPSHOT.tools.map((name, i) => ({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name, arguments: args[name] ?? {} } }));
  const s = await session([INIT, READY, ...reqs], { timeoutMs: 120_000 });
  strict(s, reqs.map(r => r.id));
  for (const [i, name] of SNAPSHOT.tools.entries()) {
    const r = s.msgs.find(m => m.id === 100 + i).result;
    assert.ok(!r.isError, `${name}: isError — ${r.content?.[0]?.text?.slice(0, 120)}`);
    const j = JSON.parse(r.content[0].text);
    if (name === "mcp_drift_check") assert.ok(Array.isArray(j.events) && j.events.every(e => e.eventId && e.id && e.type && e.at));
    if (name === "x402_leaderboard") assert.ok(Array.isArray(j.topHealthy));
    if (name === "mcp_check_server") assert.equal(j.package ?? j.id, "mcp-remote");
  }
});

test("отрицательный контроль: бэкенд отвечает 503 → инструмент возвращает isError, поле clean отсутствует", async () => {
  const srv = createServer((req, res) => { res.statusCode = 503; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "service unavailable" })); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try {
    const s = await session([INIT, READY, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: ["risky-package"] } } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mcp_check_server", arguments: { package: "mcp-remote" } } }], { backend: `http://127.0.0.1:${srv.address().port}` });
    strict(s, []);
    for (const id of [6, 7]) {
      const r = s.msgs.find(m => m.id === id).result;
      assert.ok(r?.isError, `id ${id}: при 503 ожидалась ошибка инструмента, получено: ` + JSON.stringify(r).slice(0, 200));
      assert.match(r.content[0].text, /HTTP 503/);
      assert.ok(!/"clean"\s*:/.test(r.content[0].text), "ошибка не должна нести поле clean");   // ключ JSON, не слово в тексте
    }
  } finally { srv.close(); }
});

test("отрицательный контроль: 503 на pulsefeed_products (свой fetch) → isError", () => withBackend(
  (req, res) => json(res, 503, { error: "down" }),
  async backend => {
    const s = await session([INIT, READY, { jsonrpc: "2.0", id: 11, method: "tools/call", params: { name: "pulsefeed_products", arguments: {} } }], { backend });
    strict(s, []); const r = s.msgs.find(m => m.id === 11).result; assert.ok(r?.isError && /HTTP 503/.test(r.content[0].text), JSON.stringify(r).slice(0, 200));
  }));

test("отрицательный контроль: бэкенд отвечает 200 без массива events → ошибка, не clean", async () => {
  const srv = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ generated: "x" })); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try {
    const s = await session([INIT, READY, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: ["risky-package"] } } }], { backend: `http://127.0.0.1:${srv.address().port}` });
    strict(s, []); const r = s.msgs.find(m => m.id === 8).result; assert.ok(r?.isError && /no events array/.test(r.content[0].text), JSON.stringify(r).slice(0, 200));
  } finally { srv.close(); }
});

test("mcp_check_server и x402_incidents(days): регрессия прежних инструментов, форма ответа", async () => {
  const s = await session([INIT, READY, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "mcp_check_server", arguments: { package: "mcp-remote" } } },
    { jsonrpc: "2.0", id: 10, method: "tools/call", params: { name: "x402_incidents", arguments: { days: 7 } } }]);
  strict(s, [9, 10]);
  const a = body(s, 9); assert.ok(!a.r.isError && typeof a.j.verdict === "string" && (a.j.id === "mcp-remote" || a.j.target === "mcp-remote"), "аудит пакета без verdict/id: " + JSON.stringify(a.j).slice(0, 160));
  const b = body(s, 10); assert.ok(!b.r.isError && Array.isArray(b.j.incidents), "incidents без массива incidents");
});

test("контроль валидатора протокола: схема SDK принимает настоящие сообщения и отклоняет мусор", () => {
  for (const ok of [{ jsonrpc: "2.0", id: 1, result: {} }, { jsonrpc: "2.0", id: "a", error: { code: -32600, message: "x" } }, { jsonrpc: "2.0", method: "notifications/initialized" }, { jsonrpc: "2.0", method: "n", params: { a: 1 } }]) assert.ok(isRpc(ok), "отклонено настоящее: " + JSON.stringify(ok));
  for (const bad of [{ jsonrpc: "2.0", id: 9, error: "garbage" }, { jsonrpc: "2.0", method: "notice", params: 42 }, { jsonrpc: "2.0", method: 42 }, { jsonrpc: "2.0", id: 1 }, { jsonrpc: "2.0", id: 1, result: {}, error: { code: 1, message: "x" } }, { jsonrpc: "1.0", id: 1, result: {} }, { __junk: "not json" }, "str", null]) assert.ok(!isRpc(bad), "принят мусор: " + JSON.stringify(bad));
});

test("парсер x402-челленджа из тарбола == PaymentRequiredSchema из @x402/core на 40+ телах (кроме двух объявленных правил PulseFeed: сумма из цифр, EVM payTo)", async () => {
  const { parseChallenge, decodePaymentRequiredHeader } = await import(join(consumer, "node_modules", "pulsefeed-x402-mcp", "dist", "x402Challenge.js"));
  const PAYTO = "0x7f5f784Ba98cEcFC0bA4336f0E48222A3d4d69a8", ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const v1 = { scheme: "exact", network: "base", maxAmountRequired: "10000", resource: "https://x.example/api", description: "d", mimeType: "application/json", payTo: PAYTO, maxTimeoutSeconds: 60, asset: ASSET };
  const o2 = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: ASSET, payTo: PAYTO, maxTimeoutSeconds: 60, extra: { name: "USD Coin", version: "2" } };
  const r2 = { url: "https://x.example/api", description: "d" };
  const bodies = {
    "v1 valid": { x402Version: 1, accepts: [v1] }, "v2 valid": { x402Version: 2, resource: r2, accepts: [o2] },
    "v1 empty description": { x402Version: 1, accepts: [{ ...v1, description: "" }] }, "v1 without mimeType": { x402Version: 1, accepts: [{ ...v1, mimeType: undefined }] },
    "v1 with error field": { x402Version: 1, error: "pay", accepts: [v1] }, "v2 with extensions": { x402Version: 2, resource: r2, accepts: [o2], extensions: { a: 1 } },
    "v2 mixed: {} + 'garbage' + valid": { x402Version: 2, resource: r2, accepts: [{}, "garbage", o2] },
    "v1 timeout 0.5": { x402Version: 1, accepts: [{ ...v1, maxTimeoutSeconds: 0.5 }] },
    "solana v2 (non-EVM payTo)": { x402Version: 2, resource: r2, accepts: [{ ...o2, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", payTo: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin" }] },
    "accepts [{}]": { x402Version: 1, accepts: [{}] }, "accepts ['garbage']": { x402Version: 1, accepts: ["garbage"] }, "accepts [null]": { x402Version: 1, accepts: [null] },
    "accepts {}": { x402Version: 1, accepts: {} }, "no accepts": { x402Version: 1 }, "empty accepts": { x402Version: 1, accepts: [] }, "no version": { accepts: [v1] }, "version 999": { x402Version: 999, accepts: [v1] },
    "version '1'": { x402Version: "1", accepts: [v1] }, "v2 body with v1 offers": { x402Version: 2, resource: r2, accepts: [v1] }, "v1 body with v2 offers": { x402Version: 1, accepts: [o2] },
    "v2 resource inside offer": { x402Version: 2, accepts: [{ ...o2, resource: r2 }] }, "v2 without resource": { x402Version: 2, accepts: [o2] }, "v2 resource without url": { x402Version: 2, resource: {}, accepts: [o2] },
    "v2 network not CAIP-2": { x402Version: 2, resource: r2, accepts: [{ ...o2, network: "base" }] }, "v1 no description": { x402Version: 1, accepts: [{ ...v1, description: undefined }] },
    "v1 no resource": { x402Version: 1, accepts: [{ ...v1, resource: undefined }] }, "no maxTimeoutSeconds": { x402Version: 1, accepts: [{ ...v1, maxTimeoutSeconds: undefined }] }, "maxTimeoutSeconds 0": { x402Version: 1, accepts: [{ ...v1, maxTimeoutSeconds: 0 }] }, "maxTimeoutSeconds '60'": { x402Version: 1, accepts: [{ ...v1, maxTimeoutSeconds: "60" }] },
    "empty scheme": { x402Version: 1, accepts: [{ ...v1, scheme: "" }] }, "no asset": { x402Version: 1, accepts: [{ ...v1, asset: undefined }] }, "empty payTo": { x402Version: 1, accepts: [{ ...v1, payTo: "" }] }, "no amount v2": { x402Version: 2, resource: r2, accepts: [{ ...o2, amount: undefined }] },
    "null": null, "string": "x", "array": [],
    // Правила PulseFeed сверх схемы SDK (*): у SDK сумма — любая непустая строка, payTo — любая непустая строка.
    "(*) amount '1.5'": { x402Version: 1, accepts: [{ ...v1, maxAmountRequired: "1.5" }] }, "(*) amount 'abc'": { x402Version: 1, accepts: [{ ...v1, maxAmountRequired: "abc" }] }, "amount 1e21 (number)": { x402Version: 1, accepts: [{ ...v1, maxAmountRequired: 1e21 }] }, "amount -1 v2 (number)": { x402Version: 2, resource: r2, accepts: [{ ...o2, amount: -1 }] },
    "(*) EVM payTo not an address": { x402Version: 1, accepts: [{ ...v1, payTo: "not-an-address" }] }, "(*) eip155 payTo not an address": { x402Version: 2, resource: r2, accepts: [{ ...o2, payTo: "abc" }] },
  };
  for (const [name, body] of Object.entries(bodies)) {
    const sdk = PaymentRequiredSchema.safeParse(body).success, ours = parseChallenge(body).length > 0;
    if (name.startsWith("(*)")) { assert.equal(ours, false, name + ": правило PulseFeed не сработало"); continue; }
    assert.equal(ours, sdk, `${name}: SDK=${sdk}, парсер=${ours}`);
  }
  // Мутации необязательных полей и типов (N15): SDK отклоняет — парсер обязан отклонить (он и есть SDK-схема + правила (*)).
  const base2 = { x402Version: 2, resource: { url: "http://93.184.216.34/api" }, accepts: [{ ...o2, extra: undefined }] };
  const mutations = {
    "v2 amount as number": b => { b.accepts[0].amount = 10000; }, "v2 extra 'garbage'": b => { b.accepts[0].extra = "garbage"; }, "v2 extensions []": b => { b.extensions = []; },
    "v2 resource.description 42": b => { b.resource.description = 42; }, "v2 resource.tags 42": b => { b.resource.tags = 42; }, "v2 error object": b => { b.error = { message: "pay" }; },
    "v2 maxTimeoutSeconds '60'": b => { b.accepts[0].maxTimeoutSeconds = "60"; }, "v2 resource.url ''": b => { b.resource.url = ""; },
  };
  assert.equal(PaymentRequiredSchema.safeParse(base2).success, true); assert.equal(parseChallenge(base2).length, 1);
  for (const [name, mutate] of Object.entries(mutations)) { const b = JSON.parse(JSON.stringify(base2)); mutate(b); assert.equal(PaymentRequiredSchema.safeParse(b).success, false, name + ": SDK принял?"); assert.deepEqual(parseChallenge(b), [], name + ": парсер принял"); }
  const base1 = { x402Version: 1, accepts: [v1] };
  for (const [name, mutate] of Object.entries({ "v1 amount as number": b => { b.accepts[0].maxAmountRequired = 10000; }, "v1 extra []": b => { b.accepts[0].extra = []; }, "v1 outputSchema 42": b => { b.accepts[0].outputSchema = 42; }, "v1 mimeType 42": b => { b.accepts[0].mimeType = 42; }, "v1 error 42": b => { b.error = 42; } })) {
    const b = JSON.parse(JSON.stringify(base1)); mutate(b); assert.equal(PaymentRequiredSchema.safeParse(b).success, false, name + ": SDK принял?"); assert.deepEqual(parseChallenge(b), [], name + ": парсер принял");
  }
  const v2p = parseChallenge({ x402Version: 2, resource: r2, accepts: [o2] })[0];
  assert.deepEqual(v2p, { scheme: "exact", network: "eip155:8453", payTo: PAYTO, asset: ASSET, amount: "10000", maxTimeoutSeconds: 60, resource: "https://x.example/api", version: 2 });
  assert.equal(parseChallenge({ x402Version: 2, resource: r2, accepts: [{}, "garbage", o2] }).length, 0, "мусор рядом с валидным делает челлендж невалидным (как у SDK)");
  // Заголовок PAYMENT-REQUIRED
  const enc = b => Buffer.from(JSON.stringify(b)).toString("base64");
  assert.deepEqual(decodePaymentRequiredHeader(enc({ x402Version: 2, resource: r2, accepts: [o2] })), { x402Version: 2, resource: r2, accepts: [o2] });
  for (const bad of ["!!not-base64!!", "", null, undefined, Buffer.from("[1,2]").toString("base64"), Buffer.from("null").toString("base64"), "AAAA"]) assert.equal(decodePaymentRequiredHeader(bad), null, "принят порченый заголовок: " + String(bad));
});

// Публичные фикстуры pulsefeed.dev/fixtures/x402/<name>: детерминированные 402-тела (валидные и типовые поломки).
// Страж SSRF по замыслу не пускает инструмент на локальный мок, поэтому отрицательные контроли N9 на уровне
// ИНСТРУМЕНТА идут через эти фикстуры; обогащение из /verify — с локального бэкенда.
const FIX = "https://pulsefeed.dev/fixtures/x402/";
const GOOD = ["valid-v1", "valid-v2", "header-v2", "header-and-body-v2"];
const BAD = ["mixed", "empty-offer", "garbage", "null-offer", "no-accepts", "empty-accepts", "wrong-version", "mismatch", "v2-resource-in-offer", "v2-no-resource", "v2-network-not-caip2", "v1-no-description", "no-timeout", "huge-amount", "bad-amount", "bad-payto", "header-garbage", "not-json"];
test("check_x402_endpoint на публичных фикстурах: валидные v1/v2/header-only → valid:true; 18 поломок (включая mixed) → valid:false с объяснением; ok-200 → не x402", () => withBackend(fixtures, async backend => {
  const names = [...GOOD, ...BAD, "ok-200"];
  const reqs = names.map((n, i) => ({ jsonrpc: "2.0", id: 300 + i, method: "tools/call", params: { name: "check_x402_endpoint", arguments: { url: FIX + n } } }));
  const s = await session([INIT, READY, ...reqs], { backend, timeoutMs: 240_000 });
  strict(s, reqs.map(r => r.id));
  const out = Object.fromEntries(names.map((n, i) => [n, body(s, 300 + i).j]));
  for (const n of GOOD) { const j = out[n]; assert.equal(j.status, 402, n); assert.equal(j.valid, true, n + ": " + JSON.stringify(j)); assert.equal(j.payTo, "0x1111111111111111111111111111111111111111"); assert.equal(j.price, "10000"); assert.match(j.verdict, /^live/); assert.match(j.resource, /^https:\/\/pulsefeed\.dev\/fixtures\/x402\/valid-v[12]$/); }
  assert.equal(out["valid-v1"].x402Version, 1); assert.equal(out["valid-v1"].challengeSource, "body");
  assert.equal(out["valid-v2"].x402Version, 2); assert.equal(out["valid-v2"].challengeSource, "body");
  assert.equal(out["header-v2"].x402Version, 2); assert.equal(out["header-v2"].challengeSource, "PAYMENT-REQUIRED header");
  assert.equal(out["header-and-body-v2"].challengeSource, "PAYMENT-REQUIRED header"); assert.equal(out["valid-v1"].offers, 1);
  for (const n of BAD) { const j = out[n]; assert.equal(j.status, 402, n); assert.equal(j.valid, false, n + " объявлен валидным: " + JSON.stringify(j)); assert.match(j.verdict, /^avoid/, n); assert.ok(!("price" in j), n + ": price не должен заполняться"); assert.ok(typeof j.error === "string" && j.error, n + ": нет объяснения"); }
  assert.match(out["not-json"].error, /not JSON/); assert.match(out["header-garbage"].error, /PAYMENT-REQUIRED header is not base64 JSON/);
  assert.equal(out["ok-200"].status, 200); assert.equal(out["ok-200"].valid, false); assert.match(out["ok-200"].verdict, /^avoid/);
}));

test("фикстуры и независимая схема: PaymentRequiredSchema (@x402/core) принимает ровно тела GOOD и отклоняет BAD с JSON-телом (кроме (*)-правил PulseFeed)", async () => {
  const { parseChallenge } = await import(join(consumer, "node_modules", "pulsefeed-x402-mcp", "dist", "x402Challenge.js"));
  const ours = { "bad-amount": false, "bad-payto": false };   // (*) SDK их принимает (непустые строки), PulseFeed — нет; huge-amount (число 1e21) отвергают оба
  for (const n of [...GOOD, ...BAD]) {
    const r = await fetch(FIX + n, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20_000) });
    assert.equal(r.status, 402, n);
    const h = r.headers.get("payment-required"); let b = null; try { b = await r.json(); } catch {}
    const viaHeader = h ? (() => { try { return JSON.parse(Buffer.from(h, "base64").toString("utf8")); } catch { return null; } })() : null;
    const challenge = viaHeader ?? b;
    const sdk = challenge !== null && PaymentRequiredSchema.safeParse(challenge).success;
    const expect = GOOD.includes(n);
    if (n in ours) { assert.equal(sdk, true, n + ": SDK должен принимать (это правило PulseFeed, не схемы)"); assert.equal(parseChallenge(challenge).length > 0, false); continue; }
    assert.equal(sdk, expect, `${n}: SDK=${sdk}, ожидалось ${expect}`);
    assert.equal(parseChallenge(challenge).length > 0, expect, `${n}: парсер расходится с ожиданием`);
  }
});

test("check_x402_endpoint: 402 с незавершающимся телом (фикстура hang) → таймаут 12 с, valid:false, без зависания", () => withBackend(fixtures, async backend => {
  const t0 = Date.now();
  const s = await session([INIT, READY, { jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "check_x402_endpoint", arguments: { url: FIX + "hang" } } }], { backend, timeoutMs: 40_000 });
  strict(s, [41]); const { j } = body(s, 41); const dt = Date.now() - t0;
  assert.equal(j.status, 402); assert.equal(j.valid, false); assert.match(j.error, /timeout while reading the 402 body/); assert.match(j.verdict, /^avoid/);
  assert.ok(dt >= 11_000 && dt < 25_000, "ожидался таймаут ~12 с, прошло " + dt + " мс");
}));

test("страж SSRF из тарбола: loopback/private/link-local в ЛЮБОЙ записи (IPv4, IPv4-mapped/compatible IPv6, NAT64, 6to4, hex/decimal/short IPv4, localhost, file:) → SsrfBlocked и НОЛЬ обращений к диспетчеру; публичный IP → одно; редирект на приватный адрес → блок после одного", async () => {
  const { createSafeFetch, SsrfBlocked, ipBlockedReason } = await import(join(consumer, "node_modules", "pulsefeed-x402-mcp", "dist", "ssrfGuard.js"));
  const { MockAgent } = await import(join(consumer, "node_modules", "undici", "index.js"));
  // Мок-диспетчер: сеть выключена; всё, что дошло до dispatch, считается «сетевым вызовом».
  const mock = new MockAgent(); mock.disableNetConnect(); let calls = [];
  mock.get("http://93.184.216.34").intercept({ path: /.*/, method: "GET" }).reply(o => { calls.push(o.path); return o.path.includes("redirect-me") ? { statusCode: 302, data: "", responseOptions: { headers: { location: "http://127.0.0.1/admin" } } } : { statusCode: 200, data: "{}", responseOptions: { headers: { "content-type": "application/json" } } }; }).persist();
  const sf = createSafeFetch({ dispatcher: mock });
  const blocked = ["http://127.0.0.1/admin", "http://[::ffff:127.0.0.1]/admin", "http://[::ffff:7f00:1]/admin", "http://[::ffff:169.254.169.254]/latest/meta-data/", "http://[::ffff:a9fe:a9fe]/", "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::127.0.0.1]/", "http://[2002:7f00:1::]/", "http://[2002:c0a8:101::]/", "http://[::127.0.0.1]/", "http://[::1]/", "http://[::]/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[fd00::1]/", "http://[ff02::1]/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.1.1/", "http://172.16.0.1/", "http://100.64.0.1/", "http://0.0.0.0/", "http://2130706433/", "http://0x7f000001/", "http://017700000001/", "http://127.1/", "http://127.0.0.1:8080/", "http://localhost/", "http://foo.localhost/", "http://metadata.internal/", "http://printer.local/", "file:///etc/passwd", "ftp://93.184.216.34/", "gopher://93.184.216.34/"];
  for (const u of blocked) {
    calls = [];
    let err = null; try { await sf(u, { timeoutMs: 2000 }); } catch (e) { err = e; }
    assert.ok(err instanceof SsrfBlocked, u + ": не SsrfBlocked: " + (err && err.message));
    assert.equal(calls.length, 0, u + ": обращение к диспетчеру состоялось: " + JSON.stringify(calls));
  }
  calls = []; const r = await sf("http://93.184.216.34/", { timeoutMs: 2000 }); assert.equal(r.status, 200); assert.deepEqual(calls, ["/"]);
  calls = []; let err = null; try { await sf("http://93.184.216.34/redirect-me", { timeoutMs: 2000 }); } catch (e) { err = e; }
  assert.ok(err instanceof SsrfBlocked && /loopback/.test(err.message), "редирект на loopback не заблокирован: " + (err && err.message)); assert.deepEqual(calls, ["/redirect-me"], "после блокировки редиректа не должно быть второго обращения");
  for (const ip of ["2606:4700::1111", "93.184.216.34", "2002:5db8:d822::", "64:ff9b::5db8:d822"]) assert.equal(ipBlockedReason(ip), null, ip + " публичный, но заблокирован");
  assert.ok(ipBlockedReason("2001:0:1:2:3:4:5:6"), "Teredo должен блокироваться");
  await mock.close();
});

test("DNS rebinding из тарбола: имя резолвится в публичный адрес при проверке и в 127.0.0.1 при соединении → SsrfBlocked, НОЛЬ TCP-соединений с локальным сервером; через настоящий агент", async () => {
  const { createSafeFetch, SsrfBlocked } = await import(join(consumer, "node_modules", "pulsefeed-x402-mcp", "dist", "ssrfGuard.js"));
  let connections = 0; const trap = createTcpServer(sock => { connections++; sock.end("HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok"); });
  await new Promise(r => trap.listen(0, "127.0.0.1", r)); const port = trap.address().port;
  try {
    const answers = []; let calls = 0;
    const resolve = (hostname, options, cb) => { calls++; const a = calls === 1 ? [{ address: "93.184.216.34", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]; answers.push(a[0].address); cb(null, a); };
    const sf = createSafeFetch({ resolve });
    let err = null; try { await sf(`http://rebind.test:${port}/admin`, { timeoutMs: 5000 }); } catch (e) { err = e; }
    assert.ok(err instanceof SsrfBlocked, "rebinding не заблокирован: " + (err && err.message)); assert.match(err.message, /127\.0\.0\.1/);
    assert.ok(calls >= 2, "резолвер должен вызываться и при проверке, и при соединении: " + calls); assert.deepEqual(answers.slice(0, 2), ["93.184.216.34", "127.0.0.1"]);
    assert.equal(connections, 0, "соединение с 127.0.0.1 состоялось");
    // Контроль ловушки: без стража тот же адрес соединяется (иначе ноль соединений ничего не доказывает).
    const raw = await fetch(`http://127.0.0.1:${port}/`).then(r => r.text()).catch(e => "ERR " + e.message); assert.equal(raw, "ok"); assert.equal(connections, 1);
    // Имя, честно резолвящееся в публичный адрес на обоих шагах, проходит проверку до соединения (сам запрос — в сеть, не выполняем).
    let calls2 = 0; const sf2 = createSafeFetch({ resolve: (h, o, cb) => { calls2++; cb(null, [{ address: "93.184.216.34", family: 4 }]); } });
    let err2 = null; try { await sf2("http://public.test/", { timeoutMs: 1500 }); } catch (e) { err2 = e; }
    assert.ok(!(err2 instanceof SsrfBlocked), "публичный адрес заблокирован: " + (err2 && err2.message)); assert.ok(calls2 >= 2);
  } finally { trap.close(); }
});

test("DNS без ответа из тарбола: предварительный lookup ограничен таймаутом и внешней отменой; поздний ответ DNS не запускает запрос", async () => {
  const { createSafeFetch } = await import(join(consumer, "node_modules", "pulsefeed-x402-mcp", "dist", "ssrfGuard.js"));
  const { MockAgent } = await import(join(consumer, "node_modules", "undici", "index.js"));
  const mock = new MockAgent(); mock.disableNetConnect(); let dispatched = 0;
  mock.get("http://hanging-dns.test").intercept({ path: /.*/, method: "GET" }).reply(() => { dispatched++; return { statusCode: 200, data: "{}" }; }).persist();
  try {
    const sfNever = createSafeFetch({ resolve: () => {}, dispatcher: mock });
    const t0 = Date.now(); await assert.rejects(sfNever("http://hanging-dns.test/", { timeoutMs: 50 }), e => /timeout after 50 ms/.test(e.message), "таймаут не оборвал DNS");
    assert.ok(Date.now() - t0 < 2000, "DNS-ожидание не ограничено таймаутом");
    const outer = new AbortController(); setTimeout(() => outer.abort(new Error("outer abort")), 20);
    const t1 = Date.now(); await assert.rejects(sfNever("http://hanging-dns.test/", { timeoutMs: 60_000, signal: outer.signal }), e => /outer abort/.test(e.message), "внешняя отмена не оборвала DNS");
    assert.ok(Date.now() - t1 < 2000);
    // Поздний ответ DNS (публичный адрес) после срабатывания таймаута: запрос не должен уйти.
    let lateCb = null; const sfLate = createSafeFetch({ resolve: (h, o, cb) => { lateCb = cb; }, dispatcher: mock });
    await assert.rejects(sfLate("http://hanging-dns.test/", { timeoutMs: 50 }), /timeout after 50 ms/);
    lateCb(null, [{ address: "93.184.216.34", family: 4 }]); await new Promise(r => setTimeout(r, 200));
    assert.equal(dispatched, 0, "после позднего ответа DNS ушёл запрос");
  } finally { await mock.close(); }
});

test("safeFetch из тарбола: таймаут действует на чтение тела (сервер отдал заголовки и не завершает тело) и на внешний сигнал — через настоящий агент и локальный TCP-сервер", async () => {
  const { createSafeFetch } = await import(join(consumer, "node_modules", "pulsefeed-x402-mcp", "dist", "ssrfGuard.js"));
  // Локальный сервер: заголовки 402 + начало JSON-тела, конец не приходит. Страж пускает к нему только через
  // подменённый резолвер (публичный адрес при проверке имени → на соединении тоже нужен адрес сервера, поэтому
  // резолвер отдаёт 127.0.0.1 ТОЛЬКО на этом тесте через явный allow — это тест таймаута, не стража).
  const srv = createTcpServer(sock => { sock.write("HTTP/1.1 402 Payment Required\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n5\r\n{\"a\":\r\n"); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r)); const port = srv.address().port;
  try {
    const { Agent } = await import(join(consumer, "node_modules", "undici", "index.js"));
    const straight = new Agent();   // без стража: проверяем именно таймаут тела
    const sf = createSafeFetch({ resolve: (h, o, cb) => cb(null, [{ address: "127.0.0.1", family: 4 }]), dispatcher: straight });
    // assertSafeUrl всё равно блокирует 127.0.0.1 — поэтому имя должно резолвиться в «публичный» при проверке, а соединение идёт напрямую по IP через straight-агент с Host:
    const sfPublicCheck = createSafeFetch({ resolve: (h, o, cb) => cb(null, [{ address: "93.184.216.34", family: 4 }]), dispatcher: new Agent({ connect: { lookup: (h, o, cb) => (o && o.all) ? cb(null, [{ address: "127.0.0.1", family: 4 }]) : cb(null, "127.0.0.1", 4) } }) });
    const t0 = Date.now(); const res = await sfPublicCheck(`http://hang.test:${port}/x`, { timeoutMs: 700 });
    assert.equal(res.status, 402);
    await assert.rejects(res.json(), e => /abort|timeout/i.test(e.name + e.message), "тело должно оборваться по таймауту");
    const dt = Date.now() - t0; assert.ok(dt >= 600 && dt < 5000, "таймаут тела не сработал вовремя: " + dt + " мс");
    const outer = new AbortController(); const res2 = await sfPublicCheck(`http://hang.test:${port}/y`, { timeoutMs: 60_000, signal: outer.signal });
    setTimeout(() => outer.abort(), 100); const t1 = Date.now();
    await assert.rejects(res2.json(), e => /abort/i.test(e.name + e.message), "внешний сигнал не пробросился в чтение тела"); assert.ok(Date.now() - t1 < 5000);
    void sf;
  } finally { srv.close(); }
});

test("check_x402_endpoint против живого сервера: настоящий 402-челлендж → valid:true, цена/сеть/получатель/версия заполнены", async () => {
  const s = await session([INIT, READY, { jsonrpc: "2.0", id: 31, method: "tools/call", params: { name: "check_x402_endpoint", arguments: { url: "https://pulsefeed.dev/whales" } } }], { timeoutMs: 60_000 });
  strict(s, [31]); const { r, j } = body(s, 31); assert.ok(!r.isError);
  assert.equal(j.status, 402); assert.equal(j.valid, true); assert.equal(j.reachable, true);
  assert.match(j.payTo, /^0x[0-9a-fA-F]{40}$/); assert.match(j.price, /^\d+$/); assert.ok(typeof j.network === "string" && j.network); assert.ok([1, 2].includes(j.x402Version));
  assert.match(j.verdict, /^live/);
});

test("отрицательный контроль снимка: лишний инструмент или изменённая схема не совпадают", () => {
  assert.notDeepEqual([...SNAPSHOT.tools, "zzz_extra_tool"].sort(), SNAPSHOT.tools);
  const extra = { ...SNAPSHOT.inputSchemas.mcp_drift_check, properties: { ...SNAPSHOT.inputSchemas.mcp_drift_check.properties, extra: { type: "string" } } };
  assert.ok(!sameSchema(extra, SNAPSHOT.inputSchemas.mcp_drift_check), "лишнее свойство не замечено");
  const typed = JSON.parse(JSON.stringify(SNAPSHOT.inputSchemas.mcp_drift_check)); typed.properties.days.type = "string";
  assert.ok(!sameSchema(typed, SNAPSHOT.inputSchemas.mcp_drift_check), "смена типа не замечена");
  const bounded = JSON.parse(JSON.stringify(SNAPSHOT.inputSchemas.mcp_drift_check)); bounded.properties.days.maximum = 999;
  assert.ok(!sameSchema(bounded, SNAPSHOT.inputSchemas.mcp_drift_check), "смена границы не замечена");
  const loose = JSON.parse(JSON.stringify(SNAPSHOT.inputSchemas.mcp_drift_check)); loose.additionalProperties = true;
  assert.ok(!sameSchema(loose, SNAPSHOT.inputSchemas.mcp_drift_check), "снятие additionalProperties не замечено");
  const noReq = JSON.parse(JSON.stringify(SNAPSHOT.inputSchemas.check_x402_endpoint)); delete noReq.required;
  assert.ok(!sameSchema(noReq, SNAPSHOT.inputSchemas.check_x402_endpoint), "снятие required не замечено");
});

process.on("exit", () => { try { rmSync(consumer, { recursive: true, force: true }); if (!process.env.PKG_TGZ && existsSync(tgz)) rmSync(tgz); } catch {} });

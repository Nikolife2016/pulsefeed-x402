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
// Настоящее сообщение JSON-RPC 2.0: уведомление (строковый method, без id) или ответ (id число/строка и РОВНО одно из result/error).
const isRpc = m => m && typeof m === "object" && m.jsonrpc === "2.0" && (
  (!("id" in m) && typeof m.method === "string") ||
  (("id" in m) && (typeof m.id === "number" || typeof m.id === "string") && (("result" in m) !== ("error" in m))));
const strict = (s, ids) => {
  assert.equal(s.code, 0, "код выхода сервера не 0: " + s.code + " stderr: " + s.err.slice(0, 200));
  const junk = s.msgs.filter(m => m.__junk || !isRpc(m));
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

test("тарбол: РОВНО dist/*.js, README, CHANGELOG, LICENSE и package.json — ничего лишнего", () => {
  const list = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
  const nonDist = list.filter(f => !f.startsWith("package/dist/"));
  assert.deepEqual(nonDist, ["package/CHANGELOG.md", "package/LICENSE", "package/README.md", "package/package.json"]);
  const dist = list.filter(f => f.startsWith("package/dist/"));
  assert.ok(dist.includes("package/dist/index.js") && dist.includes("package/dist/ssrfGuard.js"), "нет dist/index.js или dist/ssrfGuard.js");
  assert.ok(dist.every(f => /\.js$/.test(f)), "в dist не только .js: " + dist.join(","));
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

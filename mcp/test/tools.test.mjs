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

test("парсер x402-челленджа из тарбола: версия и обязательная для неё структура; v1/v2 принимаются, всё остальное — нет", async () => {
  const { parseChallenge, parseOffer } = await import(join(consumer, "node_modules", "pulsefeed-x402-mcp", "dist", "x402Challenge.js"));
  const PAYTO = "0x7f5f784Ba98cEcFC0bA4336f0E48222A3d4d69a8", ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
  const v1 = { scheme: "exact", network: "base", maxAmountRequired: "10000", resource: "https://x.example/api", description: "d", mimeType: "application/json", payTo: PAYTO, maxTimeoutSeconds: 60, asset: ASSET };
  const v2 = { scheme: "exact", network: "eip155:8453", amount: "10000", asset: ASSET, payTo: PAYTO, maxTimeoutSeconds: 60, resource: { url: "https://x.example/api" }, extra: { name: "USD Coin", version: "2" } };
  assert.deepEqual(parseChallenge({ x402Version: 1, accepts: [v1] }), [{ scheme: "exact", network: "base", payTo: PAYTO, asset: ASSET, amount: "10000", maxTimeoutSeconds: 60, resource: "https://x.example/api", version: 1 }]);
  assert.deepEqual(parseChallenge({ x402Version: 2, accepts: [v2] }), [{ scheme: "exact", network: "eip155:8453", payTo: PAYTO, asset: ASSET, amount: "10000", maxTimeoutSeconds: 60, resource: "https://x.example/api", version: 2 }]);
  assert.equal(parseChallenge({ x402Version: 2, accepts: [{}, "garbage", null, v2] }).length, 1, "мусор рядом с валидным отбрасывается, валидное остаётся");
  const bad = {
    "accepts:[{}]": { x402Version: 1, accepts: [{}] }, "accepts:['garbage']": { x402Version: 1, accepts: ["garbage"] }, "accepts:[null]": { x402Version: 1, accepts: [null] },
    "accepts:{}": { x402Version: 1, accepts: {} }, "no accepts": { x402Version: 1 }, "no version": { accepts: [v1] }, "version 999": { x402Version: 999, accepts: [v1] },
    "version '1' as string": { x402Version: "1", accepts: [v1] }, "v2 body with v1 fields": { x402Version: 2, accepts: [v1] }, "v1 body with v2 fields": { x402Version: 1, accepts: [v2] },
    "no maxTimeoutSeconds": { x402Version: 1, accepts: [{ ...v1, maxTimeoutSeconds: undefined }] }, "maxTimeoutSeconds 0": { x402Version: 1, accepts: [{ ...v1, maxTimeoutSeconds: 0 }] },
    "amount 1e21": { x402Version: 1, accepts: [{ ...v1, maxAmountRequired: 1e21 }] }, "amount '1.5'": { x402Version: 1, accepts: [{ ...v1, maxAmountRequired: "1.5" }] }, "amount 'abc'": { x402Version: 1, accepts: [{ ...v1, maxAmountRequired: "abc" }] }, "amount -1": { x402Version: 2, accepts: [{ ...v2, amount: -1 }] },
    "bad payTo": { x402Version: 1, accepts: [{ ...v1, payTo: "not-an-address" }] }, "empty scheme": { x402Version: 1, accepts: [{ ...v1, scheme: "" }] }, "no asset": { x402Version: 1, accepts: [{ ...v1, asset: undefined }] },
    "no resource (v1)": { x402Version: 1, accepts: [{ ...v1, resource: undefined }] }, "resource not object (v2)": { x402Version: 2, accepts: [{ ...v2, resource: "https://x.example" }] }, "resource without url (v2)": { x402Version: 2, accepts: [{ ...v2, resource: {} }] },
    "null": null, "string": "x", "array": [], "empty accepts": { x402Version: 1, accepts: [] },
  };
  for (const [name, body] of Object.entries(bad)) assert.deepEqual(parseChallenge(body), [], "принят невалидный челлендж: " + name);
  assert.equal(parseOffer({ ...v2, amount: 10000 }, 2).amount, "10000", "безопасное целое число как сумма допустимо");
  assert.equal(parseOffer({ ...v1, maxAmountRequired: Number.MAX_SAFE_INTEGER + 2 }, 1), null, "небезопасное целое — нет");
});

// Публичные фикстуры pulsefeed.dev/fixtures/x402/<name>: детерминированные 402-тела (валидные и типовые поломки).
// Страж SSRF по замыслу не пускает инструмент на локальный мок, поэтому отрицательные контроли N9 на уровне
// ИНСТРУМЕНТА идут через эти фикстуры; обогащение из /verify — с локального бэкенда.
const FIX = "https://pulsefeed.dev/fixtures/x402/";
test("check_x402_endpoint на публичных фикстурах: валидные v1/v2 → valid:true; empty/garbage/null/wrong-version/mismatch/no-timeout/huge-amount/bad-amount/bad-payto/not-json → valid:false; mixed → valid:true", () => withBackend(fixtures, async backend => {
  const names = ["valid-v1", "valid-v2", "mixed", "empty-offer", "garbage", "null-offer", "no-accepts", "wrong-version", "mismatch", "no-timeout", "huge-amount", "bad-amount", "bad-payto", "not-json", "ok-200"];
  const reqs = names.map((n, i) => ({ jsonrpc: "2.0", id: 300 + i, method: "tools/call", params: { name: "check_x402_endpoint", arguments: { url: FIX + n } } }));
  const s = await session([INIT, READY, ...reqs], { backend, timeoutMs: 180_000 });
  strict(s, reqs.map(r => r.id));
  const out = Object.fromEntries(names.map((n, i) => [n, body(s, 300 + i).j]));
  for (const n of ["valid-v1", "valid-v2", "mixed"]) { const j = out[n]; assert.equal(j.status, 402, n); assert.equal(j.valid, true, n + ": " + JSON.stringify(j)); assert.equal(j.payTo, "0x1111111111111111111111111111111111111111"); assert.equal(j.price, "10000"); assert.match(j.verdict, /^live/); }
  assert.equal(out["valid-v1"].x402Version, 1); assert.equal(out["valid-v2"].x402Version, 2); assert.equal(out["mixed"].offers, 1);
  for (const n of ["empty-offer", "garbage", "null-offer", "no-accepts", "wrong-version", "mismatch", "no-timeout", "huge-amount", "bad-amount", "bad-payto", "not-json"]) {
    const j = out[n]; assert.equal(j.status, 402, n); assert.equal(j.valid, false, n + " объявлен валидным: " + JSON.stringify(j)); assert.match(j.verdict, /^avoid/, n); assert.ok(!("price" in j), n + ": price не должен заполняться"); assert.ok(typeof j.error === "string" && j.error, n + ": нет объяснения");
  }
  assert.match(out["not-json"].error, /not JSON/);
  assert.equal(out["ok-200"].status, 200); assert.equal(out["ok-200"].valid, false); assert.match(out["ok-200"].verdict, /^avoid/);
}));

test("check_x402_endpoint: 402 с незавершающимся телом (фикстура hang) → таймаут 12 с, valid:false, без зависания", () => withBackend(fixtures, async backend => {
  const t0 = Date.now();
  const s = await session([INIT, READY, { jsonrpc: "2.0", id: 41, method: "tools/call", params: { name: "check_x402_endpoint", arguments: { url: FIX + "hang" } } }], { backend, timeoutMs: 40_000 });
  strict(s, [41]); const { j } = body(s, 41); const dt = Date.now() - t0;
  assert.equal(j.status, 402); assert.equal(j.valid, false); assert.match(j.error, /timeout while reading the 402 body/); assert.match(j.verdict, /^avoid/);
  assert.ok(dt >= 11_000 && dt < 25_000, "ожидался таймаут ~12 с, прошло " + dt + " мс");
}));

test("страж SSRF из тарбола: loopback/private/link-local в ЛЮБОЙ записи (IPv4, IPv4-mapped/compatible IPv6, NAT64, 6to4, hex/decimal/short IPv4, localhost, file:) → SsrfBlocked и НОЛЬ сетевых вызовов; публичный IP → один вызов; редирект на приватный адрес → блок", async () => {
  const { safeFetch, SsrfBlocked, ipBlockedReason } = await import(join(consumer, "node_modules", "pulsefeed-x402-mcp", "dist", "ssrfGuard.js"));
  let calls = []; const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push(String(url)); if (String(url).includes("redirect-me")) return new Response("", { status: 302, headers: { location: "http://127.0.0.1/admin" } }); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); };
  try {
    const blocked = ["http://127.0.0.1/admin", "http://[::ffff:127.0.0.1]/admin", "http://[::ffff:7f00:1]/admin", "http://[::ffff:169.254.169.254]/latest/meta-data/", "http://[::ffff:a9fe:a9fe]/", "http://[64:ff9b::7f00:1]/", "http://[64:ff9b::127.0.0.1]/", "http://[2002:7f00:1::]/", "http://[2002:c0a8:101::]/", "http://[::127.0.0.1]/", "http://[::1]/", "http://[::]/", "http://[fe80::1]/", "http://[fc00::1]/", "http://[fd00::1]/", "http://[ff02::1]/", "http://169.254.169.254/latest/meta-data/", "http://10.0.0.1/", "http://192.168.1.1/", "http://172.16.0.1/", "http://100.64.0.1/", "http://0.0.0.0/", "http://2130706433/", "http://0x7f000001/", "http://017700000001/", "http://127.1/", "http://127.0.0.1:8080/", "http://localhost/", "http://foo.localhost/", "http://metadata.internal/", "http://printer.local/", "file:///etc/passwd", "ftp://93.184.216.34/", "gopher://93.184.216.34/"];
    for (const u of blocked) {
      calls = [];
      let err = null; try { await safeFetch(u, { timeoutMs: 2000 }); } catch (e) { err = e; }
      assert.ok(err instanceof SsrfBlocked, u + ": не SsrfBlocked: " + (err && err.message));
      assert.equal(calls.length, 0, u + ": сетевой вызов состоялся: " + JSON.stringify(calls));
    }
    calls = []; const r = await safeFetch("http://93.184.216.34/", { timeoutMs: 2000 }); assert.equal(r.status, 200); assert.deepEqual(calls, ["http://93.184.216.34/"]);
    calls = []; let err = null; try { await safeFetch("http://93.184.216.34/redirect-me", { timeoutMs: 2000 }); } catch (e) { err = e; }
    assert.ok(err instanceof SsrfBlocked && /loopback/.test(err.message), "редирект на loopback не заблокирован: " + (err && err.message)); assert.equal(calls.length, 1, "после блокировки редиректа не должно быть второго вызова");
    for (const ip of ["2606:4700::1111", "93.184.216.34", "2002:5db8:d822::", "64:ff9b::5db8:d822"]) assert.equal(ipBlockedReason(ip), null, ip + " публичный, но заблокирован");
    for (const ip of ["2001:0:1:2:3:4:5:6"]) assert.ok(ipBlockedReason(ip), ip + " (Teredo) должен блокироваться");
  } finally { globalThis.fetch = realFetch; }
});

test("safeFetch из тарбола: таймаут действует на чтение тела (fetch, отдавший заголовки и зависший на json) и на внешний сигнал", async () => {
  const { safeFetch } = await import(join(consumer, "node_modules", "pulsefeed-x402-mcp", "dist", "ssrfGuard.js"));
  const realFetch = globalThis.fetch;
  const hanging = async (url, init) => ({ status: 402, headers: new Headers({ "content-type": "application/json" }), json: () => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true })) });
  globalThis.fetch = hanging;
  try {
    const t0 = Date.now(); const res = await safeFetch("http://93.184.216.34/", { timeoutMs: 300 });
    assert.equal(res.status, 402);
    await assert.rejects(res.json(), e => e.name === "AbortError", "тело должно оборваться по таймауту");
    const dt = Date.now() - t0; assert.ok(dt >= 250 && dt < 3000, "таймаут тела не сработал вовремя: " + dt + " мс");
    const outer = new AbortController(); const res2 = await safeFetch("http://93.184.216.34/", { timeoutMs: 60_000, signal: outer.signal });
    setTimeout(() => outer.abort(), 100); const t1 = Date.now();
    await assert.rejects(res2.json(), e => e.name === "AbortError", "внешний сигнал не пробросился в чтение тела"); assert.ok(Date.now() - t1 < 3000);
  } finally { globalThis.fetch = realFetch; }
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

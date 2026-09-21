// Приёмочный тест ПОСТАВЛЯЕМОГО пакета (не исходника): npm pack → установка тарбола в чистый каталог
// без dev-зависимостей и без lifecycle-скриптов → запуск bin по stdio → initialize, tools/list, tools/call.
// 06.08.2026 в npm ушла версия с тремя инструментами из одиннадцати: исходник был урезан, и ничто перед
// публикацией не проверяло, что поставляется. Имена — не контракт: контракт — имена + схемы + поведение,
// поэтому схемы сверяются с датированным снимком живого сервера, а поведение — вызовами, включая
// отказ бэкенда (локальный сервер, отвечающий 503), при котором инструмент обязан вернуть ошибку.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(new URL("..", import.meta.url).pathname);
const SNAPSHOT = JSON.parse(readFileSync(new URL("./live-tools.snapshot.json", import.meta.url), "utf8"));
const LIVE = process.env.PULSEFEED_URL || "https://pulsefeed.dev";

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
      resolve({ msgs, code, err }); });
    for (const r of requests) p.stdin.write(JSON.stringify(r) + "\n");
    const poll = setInterval(() => {
      const got = new Set(out.split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l).id]; } catch { return []; } }));
      if ([...ids].every(i => got.has(i))) { clearInterval(poll); p.stdin.end(); }
    }, 100);
  });
}
const strict = (s, ids) => {
  assert.equal(s.code, 0, "код выхода сервера не 0: " + s.code + " stderr: " + s.err.slice(0, 200));
  const junk = s.msgs.filter(m => m.__junk || !("jsonrpc" in m));
  assert.equal(junk.length, 0, "в stdout не-JSON-RPC: " + JSON.stringify(junk.slice(0, 2)));
  const init = s.msgs.find(m => m.id === 1); assert.ok(init?.result?.serverInfo?.name === "pulsefeed-x402", "initialize не вернул serverInfo: " + JSON.stringify(init).slice(0, 160));
  for (const id of ids) { const m = s.msgs.find(x => x.id === id); assert.ok(m, "нет ответа на id " + id); assert.ok(!m.error, `RPC-ошибка на id ${id}: ` + JSON.stringify(m.error)); }
};
const body = (s, id) => { const r = s.msgs.find(m => m.id === id).result; return { r, j: r.isError ? null : JSON.parse(r.content[0].text) }; };
const norm = sc => ({ props: Object.keys(sc?.properties ?? {}).sort(), required: [...(sc?.required ?? [])].sort() });

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
    assert.deepEqual(norm(t.inputSchema), norm(SNAPSHOT.inputSchemas[t.name]), `схема ${t.name} расходится со снимком`);
  }
});

test("mcp_drift_check: известный пакет с событием — в events и НЕ в clean; неизвестный — в clean", async () => {
  const s = await session([INIT, READY, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: ["@modelcontextprotocol/sdk", "definitely-not-a-real-package-xyz"], days: 30 } } }]);
  strict(s, [3]);
  const { r, j } = body(s, 3); assert.ok(!r.isError, "инструмент вернул ошибку: " + r.content?.[0]?.text);
  assert.ok(Array.isArray(j.events) && j.events.length >= 1, "ожидалось хотя бы одно событие по @modelcontextprotocol/sdk (18.09.2026)");
  assert.ok(j.events.every(e => e.eventId && e.id && e.type && e.at), "событие без eventId/id/type/at");
  assert.deepEqual(j.requested, ["@modelcontextprotocol/sdk", "definitely-not-a-real-package-xyz"]);
  assert.ok(!j.clean.includes("@modelcontextprotocol/sdk"), "пакет с событием попал в clean");
  assert.ok(j.clean.includes("definitely-not-a-real-package-xyz"), "несуществующий пакет должен быть clean");
});

test("mcp_drift_check: аргументы вне диапазона отклоняются валидатором (days=0, packages не массив)", async () => {
  const s = await session([INIT, READY, { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mcp_drift_check", arguments: { days: 0 } } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: "not-an-array" } } }]);
  assert.equal(s.code, 0);
  for (const id of [4, 5]) { const m = s.msgs.find(x => x.id === id); assert.ok(m.error || m.result?.isError, `невалидный аргумент принят (id ${id})`); }
});

test("отрицательный контроль: бэкенд отвечает 503 → инструмент возвращает isError, поле clean отсутствует", async () => {
  const srv = createServer((req, res) => { res.statusCode = 503; res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ error: "service unavailable" })); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try {
    const s = await session([INIT, READY, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: ["risky-package"] } } },
      { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "mcp_check_server", arguments: { package: "mcp-remote" } } }], { backend: `http://127.0.0.1:${srv.address().port}` });
    assert.equal(s.code, 0);
    for (const id of [6, 7]) {
      const r = s.msgs.find(m => m.id === id).result;
      assert.ok(r?.isError, `id ${id}: при 503 ожидалась ошибка инструмента, получено: ` + JSON.stringify(r).slice(0, 200));
      assert.match(r.content[0].text, /HTTP 503/);
      assert.ok(!/"clean"\s*:/.test(r.content[0].text), "ошибка не должна нести поле clean");   // ключ JSON, не слово в тексте
    }
  } finally { srv.close(); }
});

test("отрицательный контроль: бэкенд отвечает 200 без массива events → ошибка, не clean", async () => {
  const srv = createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ generated: "x" })); });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  try {
    const s = await session([INIT, READY, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: ["risky-package"] } } }], { backend: `http://127.0.0.1:${srv.address().port}` });
    const r = s.msgs.find(m => m.id === 8).result; assert.ok(r?.isError && /no events array/.test(r.content[0].text), JSON.stringify(r).slice(0, 200));
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
  const mutated = { ...SNAPSHOT.inputSchemas.mcp_drift_check, properties: { ...SNAPSHOT.inputSchemas.mcp_drift_check.properties, extra: { type: "string" } } };
  assert.notDeepEqual(norm(mutated), norm(SNAPSHOT.inputSchemas.mcp_drift_check));
});

process.on("exit", () => { try { rmSync(consumer, { recursive: true, force: true }); if (!process.env.PKG_TGZ && existsSync(tgz)) rmSync(tgz); } catch {} });

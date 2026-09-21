// Приёмочный тест ПОСТАВЛЯЕМОГО пакета (не исходника): npm pack → установка тарбола в чистый каталог
// без dev-зависимостей и без lifecycle-скриптов → запуск bin по stdio → initialize, tools/list,
// tools/call. Набор инструментов сверяется с датированным снимком живого сервера.
// 06.08.2026 в npm ушла версия с тремя инструментами из одиннадцати, потому что исходник был
// урезан, а ничто перед публикацией не проверяло набор. Этот тест и есть та проверка.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(new URL("..", import.meta.url).pathname);
const SNAPSHOT = JSON.parse(readFileSync(new URL("./live-tools.snapshot.json", import.meta.url), "utf8"));

// Тарбол: либо передан (CI публикует ровно его), либо собираем здесь.
const tgz = process.env.PKG_TGZ || (() => {
  const out = JSON.parse(execFileSync("npm", ["pack", "--json", "--silent"], { cwd: PKG, encoding: "utf8" }));
  return join(PKG, out[0].filename);
})();

const consumer = mkdtempSync(join(tmpdir(), "pf-mcp-consumer-"));
execFileSync("npm", ["init", "-y"], { cwd: consumer, stdio: "ignore" });
execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tgz], { cwd: consumer, stdio: "ignore" });
const bin = join(consumer, "node_modules", ".bin", "pulsefeed-x402-mcp");

function rpc(requests, { timeoutMs = 45_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, [], { cwd: consumer, env: { ...process.env, PULSEFEED_URL: process.env.PULSEFEED_URL || "https://pulsefeed.dev" } });
    let out = "", err = ""; const timer = setTimeout(() => { p.kill(); reject(new Error("timeout; stdout so far: " + out.slice(0, 300))); }, timeoutMs);
    p.stdout.on("data", d => { out += d; });
    p.stderr.on("data", d => { err += d; });
    p.on("close", () => { clearTimeout(timer); resolve({ out, err }); });
    for (const r of requests) p.stdin.write(JSON.stringify(r) + "\n");
    // Ждём ответов на все запросы с id, потом закрываем stdin.
    const ids = new Set(requests.filter(r => r.id != null).map(r => r.id));
    const check = setInterval(() => {
      const got = new Set(out.split("\n").filter(Boolean).flatMap(l => { try { return [JSON.parse(l).id]; } catch { return []; } }));
      if ([...ids].every(i => got.has(i))) { clearInterval(check); p.stdin.end(); }
    }, 100);
  });
}
const parse = out => out.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { __junk: l }; } });

test("tools/list установленного пакета == снимок живого сервера, stdout чистый", async () => {
  const { out } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acceptance", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
  ]);
  const msgs = parse(out);
  assert.equal(msgs.filter(m => m.__junk).length, 0, "в stdout есть не-JSON строки: " + JSON.stringify(msgs.filter(m => m.__junk).slice(0, 2)));
  const list = msgs.find(m => m.id === 2)?.result?.tools;
  assert.ok(Array.isArray(list), "нет ответа tools/list");
  const names = list.map(t => t.name).sort();
  assert.equal(new Set(names).size, names.length, "дубликаты имён");
  assert.deepEqual(names, SNAPSHOT.tools, `набор инструментов не совпал со снимком от ${SNAPSHOT.takenAt}`);
  assert.equal(names.length, 11);
  for (const t of list) assert.ok(t.inputSchema && typeof t.description === "string" && t.description.length > 40, `у ${t.name} нет схемы/описания`);
});

test("tools/call mcp_drift_check с списком пакетов: events, requested, clean", async () => {
  const { out } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acceptance", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "mcp_drift_check", arguments: { packages: ["@modelcontextprotocol/sdk", "definitely-not-a-real-package-xyz"], days: 30 } } },
  ]);
  const r = parse(out).find(m => m.id === 3);
  assert.ok(r?.result, "нет результата tools/call: " + JSON.stringify(r).slice(0, 200));
  const body = JSON.parse(r.result.content[0].text);
  assert.ok(Array.isArray(body.events), "нет events");
  assert.deepEqual(body.requested, ["@modelcontextprotocol/sdk", "definitely-not-a-real-package-xyz"]);
  assert.ok(Array.isArray(body.clean) && body.clean.includes("definitely-not-a-real-package-xyz"), "несуществующий пакет должен быть clean");
  assert.ok(body.events.every(e => e.eventId && e.id), "события без eventId/id");
});

test("tools/call mcp_check_server — регрессия прежнего инструмента", async () => {
  const { out } = await rpc([
    { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acceptance", version: "0" } } },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "mcp_check_server", arguments: { package: "mcp-remote" } } },
  ]);
  const r = parse(out).find(m => m.id === 4);
  assert.ok(r?.result?.content?.[0]?.text, "нет результата");
  const body = JSON.parse(r.result.content[0].text);
  assert.ok("verdict" in body || "package" in body, "ответ не похож на аудит пакета: " + JSON.stringify(body).slice(0, 150));
});

test("отрицательный контроль: снимок с лишним инструментом НЕ совпал бы", () => {
  const names = [...SNAPSHOT.tools, "zzz_extra_tool"].sort();
  assert.notDeepEqual(names, SNAPSHOT.tools);
});

process.on("exit", () => { try { rmSync(consumer, { recursive: true, force: true }); if (!process.env.PKG_TGZ && existsSync(tgz)) rmSync(tgz); } catch {} });

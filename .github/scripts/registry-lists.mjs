// Проверка после регистрации: официальный MCP Registry обязан отдавать ИМЕННО эту версию сервера
// (GET /v0/servers/{name}/versions/{version}) со статусом active, npm-пакетом pulsefeed-x402-mcp
// той же версии и транспортом stdio, и считать её latest. Иначе — ошибка, а не «зелёный».
// Использование: node registry-lists.mjs <version> [reg.json]   (без файла — живой запрос к Registry)
import { readFileSync, writeFileSync } from "node:fs";
const SERVER = "io.github.Nikolife2016/pulsefeed-x402", PKG = "pulsefeed-x402-mcp";
const v = process.argv[2]; if (!v) { console.error("usage: registry-lists.mjs <version> [reg.json]"); process.exit(2); }
let text;
if (process.argv[3]) text = readFileSync(process.argv[3], "utf8");
else {
  const url = `https://registry.modelcontextprotocol.io/v0/servers/${encodeURIComponent(SERVER)}/versions/${encodeURIComponent(v)}`;
  const r = await fetch(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  text = await r.text(); writeFileSync("reg.json", text);
  if (!r.ok) { console.error(`::error::registry answered HTTP ${r.status} for ${SERVER}@${v}: ${text.slice(0, 300)}`); process.exit(1); }
}
const d = JSON.parse(text);
const s = d.server ?? d, meta = d._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
const pkg = (s.packages ?? []).find(p => p.identifier === PKG);
const problems = [];
if (s.name !== SERVER) problems.push(`name is ${s.name}`);
if (s.version !== v) problems.push(`server version is ${s.version}`);
if (!pkg) problems.push(`no package ${PKG}`);
else {
  if (pkg.version !== v) problems.push(`${PKG} version is ${pkg.version}`);
  if ((pkg.registryType ?? "npm") !== "npm") problems.push(`registryType is ${pkg.registryType}`);
  if (pkg.transport?.type !== "stdio") problems.push(`transport is ${JSON.stringify(pkg.transport)}`);
}
if (meta.status && meta.status !== "active") problems.push(`status is ${meta.status}`);
if (meta.isLatest === false) problems.push("registry does not consider this version latest");
if (problems.length) { console.error(`::error::registry entry for ${SERVER}@${v} is wrong: ${problems.join("; ")}`); process.exit(1); }
console.log(`registry lists ${s.name}@${s.version} with npm ${PKG}@${pkg.version} stdio, status ${meta.status ?? "?"}, latest=${meta.isLatest ?? "?"}, published ${meta.publishedAt ?? "?"}`);

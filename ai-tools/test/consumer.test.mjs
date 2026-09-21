// Acceptance of the SHIPPED package: npm pack → the tarball installed in clean consumer directories without dev
// dependencies and without lifecycle scripts, once with ai@4 + @langchain/core@0.3 and once with ai@7 +
// @langchain/core@1 → the README scenarios run: core against a mocked PulseFeed (safe / avoid / 503 / non-JSON /
// wrong shape / timeout → checkFailed, never a silent "unknown"), core against the live PulseFeed, the Vercel
// adapter inside generateText with a mock model (the model must SEE the `endpoint` parameter — on ai@5+ it did
// not before 1.1.0), the LangChain adapter via invoke, and TypeScript consumers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PKG = resolve(new URL("..", import.meta.url).pathname);
const tgz = process.env.PKG_TGZ || (() => {
  const out = JSON.parse(execFileSync("npm", ["pack", "--json", "--silent"], { cwd: PKG, encoding: "utf8" }));
  return join(PKG, out[0].filename);
})();

// Mocked PulseFeed: behaviour chosen by the endpoint being verified.
const mock = createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const json = (code, body) => { res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(body)); };
  if (u.pathname === "/verify") {
    const ep = u.searchParams.get("endpoint") ?? "";
    if (ep.includes("scam.example")) return json(200, { endpoint: ep, known: true, verdict: "avoid", flags: ["honeypot"], advice: "do not pay" });
    if (ep.includes("good.example")) return json(200, { endpoint: ep, known: true, verdict: "safe", score: 95, live: true });
    if (ep.includes("down.example")) return json(503, { error: "down" });
    if (ep.includes("html.example")) { res.statusCode = 200; res.setHeader("content-type", "text/html"); return res.end("<!doctype html>"); }
    if (ep.includes("shape.example")) return json(200, { foo: "bar" });
    if (ep.includes("slow.example")) return setTimeout(() => json(200, { endpoint: ep, known: true, verdict: "safe" }), 2000);
    return json(200, { endpoint: ep, known: false, verdict: "unknown" });
  }
  if (u.pathname === "/status.json") return u.searchParams.get("broken") ? json(200, { nope: 1 }) : json(200, { ecosystem: { total: 1 }, catalogAudit: { checked: 1 }, topHealthy: [{ url: "https://good.example/api" }], topProviders: [] });
  json(404, { error: "not found" });
});
await new Promise(r => mock.listen(0, "127.0.0.1", r));
mock.unref();   // the mock must not keep the test process alive
const MOCK = `http://127.0.0.1:${mock.address().port}`;

const consumers = {};
for (const [name, deps] of Object.entries({ "ai4-core03": ["ai@^4", "@langchain/core@^0.3"], "ai7-core1": ["ai@^7", "@langchain/core@^1"] })) {
  const dir = mkdtempSync(join(tmpdir(), `pf-ai-tools-${name}-`));
  execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore" });
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--silent", tgz, "zod@^3.23", "typescript@^5.9", ...deps], { cwd: dir, stdio: "ignore" });
  consumers[name] = dir;
}
// Child scripts run ASYNCHRONOUSLY: a synchronous child would block this process's event loop, and the mock
// PulseFeed lives in this process — every request would time out (the first run of this file proved it).
const run = (dir, file, env = {}) => new Promise((res, rej) => execFile(process.execPath, [file], { cwd: dir, encoding: "utf8", timeout: 90_000, env: { ...process.env, PF_MOCK: MOCK, ...env } }, (err, stdout, stderr) => err ? rej(new Error(`${file} failed: ${err.message}\n${stderr}`)) : res(stdout)));
const installed = (dir, pkg) => JSON.parse(readFileSync(join(dir, "node_modules", pkg, "package.json"), "utf8")).version;

test("tarball: exactly dist/{core,vercel,langchain}.{js,d.ts}, README, CHANGELOG, LICENSE, package.json", () => {
  const list = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split("\n").filter(Boolean).sort();
  assert.deepEqual(list, ["package/CHANGELOG.md", "package/LICENSE", "package/README.md", "package/dist/core.d.ts", "package/dist/core.js", "package/dist/langchain.d.ts", "package/dist/langchain.js", "package/dist/vercel.d.ts", "package/dist/vercel.js", "package/package.json"]);
});

test("consumers got the intended framework majors", () => {
  assert.match(installed(consumers["ai4-core03"], "ai"), /^4\./); assert.match(installed(consumers["ai4-core03"], "@langchain/core"), /^0\.3\./);
  assert.match(installed(consumers["ai7-core1"], "ai"), /^7\./); assert.match(installed(consumers["ai7-core1"], "@langchain/core"), /^1\./);
});

const CORE = `
import { verifyX402Endpoint, x402TrustCatalog, PulseFeedUnavailableError } from "pulsefeed-x402-ai-tools";
const o = { apiUrl: process.env.PF_MOCK, timeoutMs: 500 };
const out = {};
for (const ep of ["good", "scam", "down", "html", "shape", "slow"]) { const v = await verifyX402Endpoint("https://" + ep + ".example/api", o); out[ep] = { verdict: v.verdict, known: v.known, checkFailed: v.checkFailed ?? false, error: v.error ?? null, advice: v.advice ?? null }; }
out.badArg = await verifyX402Endpoint("not a url", o);
out.catalog = Object.keys(await x402TrustCatalog(o)).sort();
try { await x402TrustCatalog({ ...o, apiUrl: o.apiUrl + "/?broken=1" }); out.catalogBroken = "no throw"; } catch (e) { out.catalogBroken = e instanceof PulseFeedUnavailableError ? "PulseFeedUnavailableError" : "other:" + e.message; }
console.log(JSON.stringify(out));`;
for (const name of Object.keys(consumers)) {
  test(`core (${name}): verdicts pass through; 503 / non-JSON / wrong shape / timeout / bad argument → checkFailed, never a bare unknown`, async () => {
    writeFileSync(join(consumers[name], "core.mjs"), CORE);
    const o = JSON.parse(await run(consumers[name], "core.mjs"));
    assert.deepEqual([o.good.verdict, o.good.known, o.good.checkFailed], ["safe", true, false]);
    assert.deepEqual([o.scam.verdict, o.scam.checkFailed], ["avoid", false]);
    for (const k of ["down", "html", "shape", "slow"]) { assert.equal(o[k].checkFailed, true, k + " not flagged: " + JSON.stringify(o[k])); assert.equal(o[k].verdict, "unknown"); assert.equal(o[k].known, false); assert.match(o[k].advice, /No verdict was produced/); }
    assert.match(o.down.error, /HTTP 503/); assert.match(o.html.error, /non-JSON/); assert.match(o.shape.error, /unexpected body/); assert.match(o.slow.error, /timeout/);
    assert.equal(o.badArg.checkFailed, true); assert.match(o.badArg.error, /http\(s\) endpoint URL/);
    assert.deepEqual(o.catalog, ["catalogAudit", "dataset", "ecosystem", "note", "security", "topHealthy", "topProviders"]);
    assert.equal(o.catalogBroken, "PulseFeedUnavailableError");
  });
}

test("core against the live PulseFeed: a known endpoint gets a real verdict; the catalog lists services", async () => {
  const dir = consumers["ai7-core1"];
  writeFileSync(join(dir, "live.mjs"), `
import { verifyX402Endpoint, x402TrustCatalog } from "pulsefeed-x402-ai-tools";
const v = await verifyX402Endpoint("https://pulsefeed.dev/whales"); const c = await x402TrustCatalog();
console.log(JSON.stringify({ known: v.known, verdict: v.verdict, checkFailed: v.checkFailed ?? false, score: v.score, topHealthy: Array.isArray(c.topHealthy) ? c.topHealthy.length : -1 }));`);
  const o = JSON.parse(await run(dir, "live.mjs"));
  assert.equal(o.checkFailed, false, JSON.stringify(o)); assert.equal(o.known, true); assert.ok(["safe", "caution", "avoid", "unknown"].includes(o.verdict)); assert.ok(o.topHealthy > 0);
});

// Vercel adapter inside generateText with a mock model: what the MODEL sees (input schema) and that the call executes.
const VERCEL_AI4 = `
import { generateText } from "ai";
import { MockLanguageModelV1 } from "ai/test";
import { createPulsefeedTools, pulsefeedTools } from "pulsefeed-x402-ai-tools/vercel";
const tools = createPulsefeedTools({ apiUrl: process.env.PF_MOCK });
let seen = null, call = 0;
const model = new MockLanguageModelV1({ doGenerate: async (o) => { seen = (o.mode?.tools ?? []).map(t => ({ name: t.name, schema: t.parameters })); call++;
  if (call === 1) return { toolCalls: [{ toolCallType: "function", toolCallId: "c1", toolName: "verifyX402Endpoint", args: JSON.stringify({ endpoint: "https://scam.example/api" }) }], finishReason: "tool-calls", usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} } };
  return { text: "done", finishReason: "stop", usage: { promptTokens: 1, completionTokens: 1 }, rawCall: { rawPrompt: null, rawSettings: {} } }; } });
const r = await generateText({ model, tools, maxSteps: 3, prompt: "Is https://scam.example/api safe?" });
const results = r.steps.flatMap(s => s.toolResults ?? []).map(t => ({ toolName: t.toolName, verdict: t.result?.verdict, checkFailed: t.result?.checkFailed ?? false }));
console.log(JSON.stringify({ seen, results, defaultNames: Object.keys(pulsefeedTools) }));`;
const VERCEL_AI7 = `
import { generateText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createPulsefeedTools, pulsefeedTools } from "pulsefeed-x402-ai-tools/vercel";
const tools = createPulsefeedTools({ apiUrl: process.env.PF_MOCK });
let seen = null, call = 0;
const usage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
const model = new MockLanguageModelV4({ doGenerate: async (o) => { seen = (o.tools ?? []).map(t => ({ name: t.name, schema: t.inputSchema })); call++;
  if (call === 1) return { content: [{ type: "tool-call", toolCallId: "c1", toolName: "verifyX402Endpoint", input: JSON.stringify({ endpoint: "https://scam.example/api" }) }], finishReason: { unified: "tool-calls", raw: "tool-calls" }, usage, warnings: [] };
  return { content: [{ type: "text", text: "done" }], finishReason: { unified: "stop", raw: "stop" }, usage, warnings: [] }; } });
const r = await generateText({ model, tools, stopWhen: stepCountIs(3), prompt: "Is https://scam.example/api safe?" });
const results = r.steps.flatMap(s => s.toolResults ?? []).map(t => ({ toolName: t.toolName, verdict: t.output?.verdict, checkFailed: t.output?.checkFailed ?? false }));
console.log(JSON.stringify({ seen, results, defaultNames: Object.keys(pulsefeedTools) }));`;
for (const [name, src] of [["ai4-core03", VERCEL_AI4], ["ai7-core1", VERCEL_AI7]]) {
  test(`Vercel AI SDK (${name}): generateText shows the model the endpoint parameter and executes the tool`, async () => {
    writeFileSync(join(consumers[name], "vercel.mjs"), src);
    const o = JSON.parse(await run(consumers[name], "vercel.mjs"));
    assert.deepEqual(o.defaultNames, ["verifyX402Endpoint", "x402TrustCatalog"]);
    assert.deepEqual(o.seen.map(t => t.name), ["verifyX402Endpoint", "x402TrustCatalog"]);
    const s = o.seen[0].schema;
    assert.deepEqual(s.required, ["endpoint"], "model does not see endpoint as required: " + JSON.stringify(s));
    assert.equal(s.properties?.endpoint?.type, "string");
    assert.deepEqual(o.results, [{ toolName: "verifyX402Endpoint", verdict: "avoid", checkFailed: false }]);
  });
}

const LANGCHAIN = `
import { createPulsefeedTools, pulsefeedTools } from "pulsefeed-x402-ai-tools/langchain";
const tools = createPulsefeedTools({ apiUrl: process.env.PF_MOCK });
const out = { names: tools.map(t => t.name), defaultNames: pulsefeedTools.map(t => t.name) };
out.scam = JSON.parse(await tools[0].invoke({ endpoint: "https://scam.example/api" }));
out.down = JSON.parse(await tools[0].invoke({ endpoint: "https://down.example/api" }));
out.catalog = Object.keys(JSON.parse(await tools[1].invoke({}))).sort();
try { await tools[0].invoke({ url: "x" }); out.wrongInput = "no throw"; } catch (e) { out.wrongInput = e.name; }
console.log(JSON.stringify(out));`;
for (const name of Object.keys(consumers)) {
  test(`LangChain (${name}): DynamicStructuredTool invoke returns JSON verdicts; wrong input is rejected by the schema`, async () => {
    writeFileSync(join(consumers[name], "lc.mjs"), LANGCHAIN);
    const o = JSON.parse(await run(consumers[name], "lc.mjs"));
    assert.deepEqual(o.names, ["verify_x402_endpoint", "x402_trust_catalog"]); assert.deepEqual(o.defaultNames, o.names);
    assert.equal(o.scam.verdict, "avoid"); assert.equal(o.down.checkFailed, true);
    assert.deepEqual(o.catalog, ["catalogAudit", "dataset", "ecosystem", "note", "security", "topHealthy", "topProviders"]);
    assert.match(o.wrongInput, /ToolInputParsingException|Error/);
  });
}

for (const name of Object.keys(consumers)) {
  test(`TypeScript (${name}): consumers of core, vercel (inside generateText) and langchain type-check (tsc --noEmit)`, () => {
    const dir = consumers[name];
    writeFileSync(join(dir, "t.mts"), `
import { generateText } from "ai";
import { verifyX402Endpoint, type VerifyResult, PulseFeedUnavailableError } from "pulsefeed-x402-ai-tools";
import { pulsefeedTools, createPulsefeedTools } from "pulsefeed-x402-ai-tools/vercel";
import { pulsefeedTools as lcTools } from "pulsefeed-x402-ai-tools/langchain";
export const v: Promise<VerifyResult> = verifyX402Endpoint("https://x.example");
export const e = new PulseFeedUnavailableError("x", 503);
export const t = createPulsefeedTools({ timeoutMs: 100 });
export const run = (model: any) => generateText({ model, tools: pulsefeedTools, prompt: "x" } as any);
export const n: string[] = lcTools.map(x => x.name);`);
    writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, target: "ES2022", lib: ["ES2022", "DOM"] }, files: ["t.mts"] }));
    execFileSync(join(dir, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], { cwd: dir, encoding: "utf8" });
    // Our own .d.ts files are checked with skipLibCheck: false (third-party typings excluded via a file that imports only the core).
    writeFileSync(join(dir, "own.mts"), `import { verifyX402Endpoint } from "pulsefeed-x402-ai-tools"; export const p = verifyX402Endpoint("https://x.example");`);
    writeFileSync(join(dir, "tsconfig.own.json"), JSON.stringify({ compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: false, types: [], target: "ES2022", lib: ["ES2022", "DOM"] }, files: ["own.mts"] }));
    execFileSync(join(dir, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.own.json"], { cwd: dir, encoding: "utf8" });
  });
}

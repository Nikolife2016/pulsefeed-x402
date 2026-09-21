# pulsefeed-x402-ai-tools — changelog

Versioning policy: a new export, option or result field is a **minor** release; a fix that changes no export,
option or result field is a **patch**; removing or renaming an export, changing a result field incompatibly,
or dropping a Node line that is still maintained is a **major**. Dropping a Node line that has reached end of
life is treated as minor and is stated here.

## 1.1.0 — 2026-09-21

- Fix (Vercel AI SDK adapter): the tools carried only `parameters`, which `ai` 5, 6 and 7 ignore — the model
  was shown an **empty** input schema and never learned it must pass `endpoint`. The tools now carry both
  `parameters` (ai 3/4) and `inputSchema` (ai 5+); verified inside `generateText` on ai 4 and ai 7 with a
  mock model. The adapter no longer imports `ai` at build time. Peer range narrowed to `ai >=3 <8`,
  `@langchain/core >=0.2 <2` (tested: 0.3 and 1.x).
- New result fields `checkFailed: true` and `error` on `verifyX402Endpoint` when PulseFeed could not be
  consulted (HTTP error, timeout, non-JSON, unexpected body) or the argument is not an http(s) URL. Before,
  such failures came back as a bare `verdict: "unknown"`, indistinguishable from "endpoint not in the index",
  with advice text in Russian. `x402TrustCatalog` throws the new `PulseFeedUnavailableError` in those cases
  (the adapters surface it as a tool error). **Minor.**
- Response bodies are validated (`known` boolean, `verdict` in the known set; the catalog needs a
  `topHealthy` array and an `ecosystem` object) before being returned.
- Types: the Vercel tool set is a type alias assignable to `generateText`'s `ToolSet` (an interface was not:
  TS2322); the LangChain adapter is declared as `StructuredToolInterface[]`, so its `.d.ts` compiles on
  `@langchain/core` 0.3 as well as 1.x. The README example is compiled verbatim in the acceptance test on
  ai 4 and ai 7.
- Tool descriptions and the package description no longer carry a broken placeholder for the share of dead
  endpoints; the live figure is referenced instead.
- `engines.node` raised from `>=18` to `>=20` (Node 18 end of life 30 April 2025; tested on 20 and 24).
- `LICENSE` (MIT) shipped; `repository` points at this repository (`ai-tools/`).
- Acceptance test: the packed tarball installed as a consumer would, twice (ai 4 + @langchain/core 0.3, ai 7 +
  @langchain/core 1), exercising core (mocked and live PulseFeed), both adapters and TypeScript consumers.

## 1.0.0 — 2026-07-07

- First release: core, Vercel AI SDK adapter (ai 3/4 tool shape), LangChain adapter.

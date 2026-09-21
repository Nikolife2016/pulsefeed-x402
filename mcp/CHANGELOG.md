# pulsefeed-x402-mcp — changelog

Versioning policy: a new public tool or a new field in a tool's output is a **minor** release; a fix that
changes no tool name, schema or output shape is a **patch**; removing or renaming a tool, changing a schema
incompatibly, or dropping a Node line that is still maintained is a **major**. Dropping a Node line that has
reached end of life is treated as minor and is stated here.

## 1.1.0 — 2026-09-21

- Every tool's input schema is a strict object (`additionalProperties: false`), equal to the live server's.
- New tool `mcp_drift_check` — supply-chain drift events (maintainer, publisher, install-script, binary
  changes) for a list of npm packages, from `pulsefeed.dev/mcp/drift.json`; `clean` lists the requested
  packages with no event in the window. **Minor.**
- Every tool now returns an MCP error (`isError: true`, "No verdict was produced; do not treat this as
  clean") when PulseFeed answers with a non-2xx status, non-JSON, an unexpected body, or malformed drift
  events (an event needs non-empty `id`, `type` and a parseable `at`). Before, backend failures could surface
  as an exception or, for `pulsefeed_products`, as raw HTML.
- `check_x402_endpoint` validates the 402 body by protocol version before saying `valid: true`: `x402Version`
  must be 1 or 2, and each offer needs `scheme`, `network`, an EVM `payTo`, `asset`, `resource` (a string in
  v1, `{url}` in v2), a positive integer `maxTimeoutSeconds` and a decimal-digit amount (`maxAmountRequired`
  in v1, `amount` in v2). Before, `{"accepts":[{}]}` or `["garbage"]` counted as a valid challenge with the
  verdict "safe to consider paying"; a v2 body with v1 fields, version 999, a missing timeout or `1e21` as the
  amount were accepted too. The answer carries `x402Version` and the number of valid `offers`; a 402 whose body
  is not JSON or never finishes says so in `error`. Conformance fixtures: `pulsefeed.dev/fixtures/x402`.
- SSRF guard: an embedded IPv4 address is checked in every IPv6 form — IPv4-mapped in hex (`::ffff:7f00:1`),
  IPv4-compatible, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`) — plus multicast and Teredo. Before,
  `http://[::ffff:127.0.0.1]/` and `[::ffff:169.254.169.254]` passed the guard (only the dotted form was
  recognised). The acceptance test asserts zero network calls for every blocked form.
- The 12-second timeout of `check_x402_endpoint` now covers reading the 402 body, and the caller's abort
  signal is forwarded into `safeFetch`; a server that never finishes the body used to hold the tool forever.
- `pulsefeed_products` requests JSON explicitly (the root route serves HTML without `accept: application/json`).
- `x402_changes` and `x402_incidents` accept `days`; `mcp_drift_check` limits `packages` to 200 and `days`
  to 1–365, matching the live server.
- `engines.node` raised from `>=18` to `>=20`. Node 18 reached end of life on 30 April 2025; the package is
  tested on Node 20 and 24. No API absent in Node 18 is used, but only the tested range is promised.
- `LICENSE` (MIT) is shipped in the tarball; `dist` and `node_modules` are no longer tracked in git.
- Acceptance test runs against the packed tarball installed as a consumer would: tool names and full input
  schemas against a dated snapshot of the live server's `tools/list`, all eleven tools called, backend
  failures and malformed events, tarball contents.

## 1.0.7 — 2026-08-06 (npm `latest` until 1.1.0)

- Shipped with three of the eleven tools: the source itself had been cut by a clean-up commit on 2026-08-04
  and nothing checked what was being published. A 1.0.8 restoring the tools was prepared but never reached
  npm; 1.1.0 supersedes it and adds the acceptance test that would have caught the cut.

## 1.0.0 – 1.0.6 — 2026-07-06 … 2026-07-31

- Initial releases (x402 tools, then the MCP supply-chain tools).

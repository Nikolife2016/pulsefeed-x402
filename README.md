# PulseFeed

**Verify before you pay or install.**

Two questions an agent has to answer before it acts, and neither is answered by a scanner that
only looks at the present:

- **Is this x402 endpoint safe to pay?** — liveness, a 0–100 trust score, scam flags
  (receiver swapped, catalog price ≠ challenge price, honeypot receiver, testnet listed as
  production), with a pay/avoid verdict and on-chain proof links on Base.
- **Did this MCP server or npm package change *after* people adopted it?** — an install
  script added in a later version, ownership swapped, repository removed, package
  unpublished, build provenance lost.

The second question is the one static scanners cannot answer. A rug pull is clean at review
time by construction: the package collects installs for weeks, and only then ships the patch
that runs code on `npm i`. Answering it requires yesterday's snapshot to exist, which is why
the series here starts on 2026-07-30 and cannot be reconstructed after the fact.

PulseFeed re-audits the whole MCP registry every night and diffs it against the previous
day's snapshot, and re-probes the x402 endpoint population daily. Everything below is free,
needs no key, and no account.

---

## MCP server

Hosted, no install:

```
https://pulsefeed.dev/mcp-server
```

Streamable HTTP. Also on the [official MCP registry](https://registry.modelcontextprotocol.io),
[Smithery](https://smithery.ai/server/nikolife2016/pulsefeed-x402) and
[Glama](https://glama.ai/mcp/servers/Nikolife2016/pulsefeed-x402).

Or run it locally — see [`mcp/`](./mcp):

```bash
npx pulsefeed-x402-mcp
```

Tools include `check_x402_endpoint` (is this endpoint safe to pay), `mcp_check_server`
(audit before installing), `mcp_drift_check` (**the rug-pull check** — pass your own
dependency list), `mcp_security_report`, `x402_incidents` and `x402_changes`.

## Drift badge

Put it in your README. It states what changed in your package after people adopted it:

```markdown
[![MCP drift](https://pulsefeed.dev/badge/mcp.svg?package=YOUR-PACKAGE)](https://pulsefeed.dev/mcp/drift)
```

Use your registry name (`io.github.you/your-server`) or your npm package name.

A green badge is a public claim about your package, so it is only issued when the package is
actually in our snapshot. When it is not, the badge reads **`unwatched`** in grey — never
green. Reporting absence of measurement as evidence of cleanliness is a mistake we made once
publicly and will not repeat; see [the correction](https://pulsefeed.dev/correction).

## CI check

Fails the build when something you already depend on changes dangerously:

```yaml
- uses: Nikolife2016/mcp-drift-action@v1
```

[Marketplace](https://github.com/marketplace/actions/mcp-drift-check) ·
[source](https://github.com/Nikolife2016/mcp-drift-action). Run it on a schedule, not only on
pull requests — drift happens between your commits.

## Free API

No key, CORS enabled, safe to call from a browser or a catalog page:

```bash
# what changed, whole registry
curl -s "https://pulsefeed.dev/mcp/drift.json?days=7"

# only your dependencies
curl -s "https://pulsefeed.dev/mcp/drift.json?packages=pkg-a,pkg-b&days=7"

# is this x402 endpoint payable
curl -s "https://pulsefeed.dev/verify?endpoint=<url>"
```

Subscribe without signing up — the filter lives in the URL, so there is no subscriber
database and nothing to leak:

```
https://pulsefeed.dev/mcp/drift.rss?packages=pkg-a,pkg-b
```

Full spec: [`/openapi.json`](https://pulsefeed.dev/openapi.json).

## Open data

- Live feed: [pulsefeed.dev/mcp/drift](https://pulsefeed.dev/mcp/drift)
- Ecosystem state: [pulsefeed.dev/status.json](https://pulsefeed.dev/status.json)
- Dataset: [Nikolife/pulsefeed-x402-security](https://huggingface.co/datasets/Nikolife/pulsefeed-x402-security)

## On being wrong in public

We once published that 76% of x402 endpoints were dead. That measured our own parser, not the
market, and the figure was corrected twice more after that — each time downward, each time for
the same class of reason: our own behaviour recorded as somebody else's track record. The
whole mechanism, every correction and the checklist that came out of it are kept at
[pulsefeed.dev/correction](https://pulsefeed.dev/correction) rather than quietly deleted.

If you find a number here that does not hold, open an issue — that page is where it will end
up.

## What's in this repository

| | |
|---|---|
| [`mcp/`](./mcp) | the MCP server (`pulsefeed-x402-mcp` on npm) |
| [`lint/`](./lint) | `x402-payable` — is your x402 endpoint actually payable |
| [`data/`](./data) | published series and snapshots |
| `server.json` | manifest for the official MCP registry |

## License

MIT

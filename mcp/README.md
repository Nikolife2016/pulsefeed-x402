# pulsefeed-x402-mcp

MCP server for the **x402 agent-payment ecosystem** and the **MCP supply chain**. Gives AI agents (Claude Desktop, Cursor, Cline, Windsurf, VS Code) eleven tools, all free, no API key:

**Before your agent pays**
- **`check_x402_endpoint`** — is this x402 endpoint live, and does it return a valid payment challenge? Liveness, price, network, pay/avoid verdict.
- **`x402_working_services`** — the x402 services that are actually alive, ranked by trust score.
- **`x402_leaderboard`** — most reliable services over time.
- **`x402_incidents`** — recent scam/anomaly incidents: payTo hijack, price bait-and-switch, honeypots, dead-on-arrival.
- **`x402_changes`** — what changed in the ecosystem since yesterday.
- **`x402_ecosystem_stats`** — population, liveness, dead share.
- **`x402_data_sample`** — a sample of the trust dataset.

**Before your agent installs an MCP server**
- **`mcp_check_server`** — audit an npm MCP package: install scripts, abandonment, repository, licence, provenance — verdict safe/caution/avoid.
- **`mcp_drift_check`** — the rug-pull check: what changed in a package *after* you adopted it — install script added later, ownership swapped, repository removed, unpublished, provenance lost. Pass your own dependency list.
- **`mcp_security_report`** — state of MCP security with day-over-day deltas.

**About PulseFeed**
- **`pulsefeed_products`** — what PulseFeed offers and at what price.

Backed by [PulseFeed](https://pulsefeed.dev), an independent daily re-audit of the x402 endpoint population and the whole MCP registry. The same tools are served over Streamable HTTP at `https://pulsefeed.dev/mcp-server`.

## Use in Claude Desktop / Cursor / Cline

```json
{
  "mcpServers": {
    "pulsefeed-x402": {
      "command": "npx",
      "args": ["-y", "pulsefeed-x402-mcp"]
    }
  }
}
```

Config: `PULSEFEED_URL` overrides the backend base URL.

## Development

```bash
npm ci --include=dev
npm run build          # tsc → dist/
npm test               # packs a tarball, installs it in a clean directory as a consumer would,
                       # runs the server over stdio and checks the tool set against
                       # test/live-tools.snapshot.json
```

`dist/` and `node_modules/` are not tracked in git. The published tarball is built once in CI, tested as installed, published under the `next` dist-tag, verified against what npm serves, and only then promoted to `latest` — see `.github/workflows/publish-mcp.yml`. Release: push a tag `mcp-v<version>` matching `package.json`, or run the workflow manually and type the version to confirm.

## Licence

MIT

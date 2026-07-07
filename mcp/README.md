# pulsefeed-x402-mcp

MCP server for the **x402 agent-payment ecosystem**. Gives AI agents (Claude Desktop, Cursor, Cline, Windsurf, VS Code) tools to navigate x402:

- **`x402_working_services`** — list x402 services that are actually alive (≈85% are dead/invalid).
- **`check_x402_endpoint`** — verify an endpoint returns a valid x402 challenge before paying it.
- **`pulsefeed_products`** — PulseFeed's paid on-chain intelligence products (Base token pulse, whale alerts, smart-money flow, momentum, trust oracle).

Backed by [PulseFeed](https://pulsefeed.dev/status).

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

## Local run
```bash
npm install
npm run start      # tsx dev run
# or build + run:
npm run build && node dist/index.js
```

Config: `PULSEFEED_URL` env overrides the backend base URL.

## Publish (maintainer)
```bash
npm run build && npm publish --access public
```

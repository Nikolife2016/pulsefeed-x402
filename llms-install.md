# Installing pulsefeed-x402-mcp

PulseFeed MCP server: verify any x402 payment endpoint before an AI agent pays it — liveness, scam/anomaly scan (payTo hijack, bait-and-switch, honeypot), on-chain receiver verification and an open Trust Score. No API key required.

## Claude Desktop / Claude Code
Add to `claude_desktop_config.json` (or `.mcp.json`):
```json
{ "mcpServers": { "pulsefeed": { "command": "npx", "args": ["-y", "pulsefeed-x402-mcp"] } } }
```

## Cursor / Cline / Windsurf / VS Code
Same command everywhere — stdio server via npx, zero configuration:
```json
{ "command": "npx", "args": ["-y", "pulsefeed-x402-mcp"] }
```

## What you get (tools)
- `check_x402_endpoint` — is this x402 endpoint safe to pay? verdict + flags before payment
- `x402_working_services` — catalog of currently-live x402 services ranked by trust score
- `pulsefeed_products` — PulseFeed's paid deep-check products and how to pay via x402

No environment variables required. Requires Node.js 18+.

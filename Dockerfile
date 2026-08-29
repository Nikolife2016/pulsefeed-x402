# MCP server: pulsefeed-x402-mcp — verify x402 endpoints before an agent pays.
# Builds the TypeScript MCP server and runs it on stdio (MCP introspection lists 10 tools).
FROM node:20-slim
WORKDIR /app
# Copy ALL sources BEFORE `npm install` — package.json has a "prepare": "tsc" script that
# runs during install, so tsconfig.json + every .ts source must already be present.
# ssrfGuard.ts is imported by index.ts: omit it and the build fails.
COPY mcp/package.json mcp/tsconfig.json mcp/index.ts mcp/ssrfGuard.ts ./
RUN npm install && npm run build
# Stdio MCP server; answers MCP introspection with no network access needed.
CMD ["node", "dist/index.js"]

# MCP server: pulsefeed-x402-mcp — verify x402 endpoints before an agent pays.
# For Glama.ai introspection: builds the TypeScript MCP server and runs it on stdio.
FROM node:20-slim
WORKDIR /app
# Copy ALL sources BEFORE `npm install` — package.json has a "prepare": "tsc" script that
# runs during install, so tsconfig.json + index.ts must already be present or the build fails.
COPY mcp/package.json mcp/tsconfig.json mcp/index.ts ./
RUN npm install && npm run build
# Stdio MCP server; responds to MCP introspection (lists 3 tools) with no network needed.
CMD ["node", "dist/index.js"]

# MCP server: pulsefeed-x402-mcp — verify x402 endpoints before an agent pays.
# For Glama.ai introspection: builds the TypeScript MCP server and runs it on stdio.
FROM node:20-slim
WORKDIR /app
COPY mcp/package.json ./
RUN npm install
COPY mcp/index.ts mcp/tsconfig.json ./
RUN npm run build
# Stdio MCP server; responds to MCP introspection (lists 3 tools) with no network needed.
CMD ["node", "dist/index.js"]

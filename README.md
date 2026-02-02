# Mem.ai MCP Server

MCP server for integrating Mem.ai with Claude.

## Setup

1. Deploy to Railway
2. Add MEM_API_KEY environment variable
3. Use the SSE endpoint in Claude.ai connectors

## Endpoint

- SSE: `https://your-railway-app.railway.app/sse`
- Health check: `https://your-railway-app.railway.app/health`

## Tools Available

- `mem_search` - Search notes in Mem.ai
- `mem_create` - Create new notes
- `mem_read` - Read specific notes by ID

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import { createServer } from "http";

const MEM_API_KEY = process.env.MEM_API_KEY;
const MEM_API_BASE = "https://api.mem.ai/v1";

// Store transports by sessionId for multiple connections
const transports = {};

// Create MCP server
const server = new Server(
  {
    name: "mem-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Function to call Mem.ai API
async function callMemAPI(endpoint, method = "GET", body = null) {
  const options = {
    method,
    headers: {
      "Authorization": `ApiKey ${MEM_API_KEY}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`${MEM_API_BASE}${endpoint}`, options);
  
  if (!response.ok) {
    throw new Error(`Mem.ai API error: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "mem_search",
        description: "Search for notes in Mem.ai based on a query",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Search query to find relevant notes",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return (default: 10)",
              default: 10,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "mem_create",
        description: "Create a new note in Mem.ai",
        inputSchema: {
          type: "object",
          properties: {
            content: {
              type: "string",
              description: "The content of the note to create",
            },
          },
          required: ["content"],
        },
      },
      {
        name: "mem_read",
        description: "Read a specific note by ID from Mem.ai",
        inputSchema: {
          type: "object",
          properties: {
            note_id: {
              type: "string",
              description: "The ID of the note to read",
            },
          },
          required: ["note_id"],
        },
      },
    ],
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case "mem_search": {
        const limit = args.limit || 10;
        const result = await callMemAPI(`/mems/search?q=${encodeURIComponent(args.query)}&limit=${limit}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      case "mem_create": {
        const result = await callMemAPI("/mems", "POST", {
          content: args.content,
        });
        return {
          content: [
            {
              type: "text",
              text: `Note created successfully with ID: ${result.id}\n\n${JSON.stringify(result, null, 2)}`,
            },
          ],
        };
      }

      case "mem_read": {
        const result = await callMemAPI(`/mems/${args.note_id}`);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Helper to parse request body
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// Helper to parse URL and query params
function parseUrl(req) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  return {
    pathname: url.pathname,
    searchParams: url.searchParams
  };
}

// Create HTTP server with SSE
const httpServer = createServer(async (req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const { pathname, searchParams } = parseUrl(req);
  
  // SSE endpoint - establishes the connection
  if (pathname === "/sse" && req.method === "GET") {
    console.log("SSE connection received");
    
    try {
      // Create transport - the path '/messages' tells clients where to POST
      const transport = new SSEServerTransport("/messages", res);
      
      // Store transport by sessionId for later retrieval
      transports[transport.sessionId] = transport;
      console.log(`Created session: ${transport.sessionId}`);
      
      // Clean up on connection close
      res.on("close", () => {
        console.log(`Session closed: ${transport.sessionId}`);
        delete transports[transport.sessionId];
      });
      
      // Connect the MCP server to this transport
      await server.connect(transport);
    } catch (error) {
      console.error("SSE connection error:", error);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end("Internal Server Error");
      }
    }
    return;
  }
  
  // Messages endpoint - handles client-to-server communication
  if (pathname === "/messages" && req.method === "POST") {
    // Get sessionId from query params (set by SSEServerTransport)
    const sessionId = searchParams.get('sessionId');
    console.log(`Message received for session: ${sessionId}`);
    
    if (!sessionId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Missing sessionId parameter" }));
      return;
    }
    
    const transport = transports[sessionId];
    
    if (!transport) {
      console.error(`No transport found for session: ${sessionId}`);
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Session not found" }));
      return;
    }
    
    try {
      // Let the transport handle the POST message
      await transport.handlePostMessage(req, res);
    } catch (error) {
      console.error("Error handling message:", error);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
    return;
  }
  
  // Health check endpoint
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ 
      status: "ok",
      activeSessions: Object.keys(transports).length 
    }));
    return;
  }
  
  // 404 for unknown routes
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`MCP Mem.ai server running on port ${PORT}`);
  console.log(`SSE endpoint: /sse`);
  console.log(`Messages endpoint: /messages`);
  console.log(`Health check: /health`);
});

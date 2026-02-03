import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express from "express";

const MEM_API_KEY = process.env.MEM_API_KEY;
const MEM_API_BASE = "https://api.mem.ai/v1";

// Store transports by sessionId for multiple simultaneous connections
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

// Create Express app
const app = express();

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// SSE endpoint - establishes the connection
app.get("/sse", async (req, res) => {
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
      res.status(500).send("Internal Server Error");
    }
  }
});

// Messages endpoint - handles client-to-server communication
// The SDK's handlePostMessage reads the raw body, so don't use express.json() globally
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  console.log(`Message received for session: ${sessionId}`);
  
  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId parameter" });
  }
  
  const transport = transports[sessionId];
  
  if (!transport) {
    console.error(`No transport found for session: ${sessionId}`);
    return res.status(404).json({ error: "Session not found" });
  }
  
  try {
    // Let the transport handle the POST message
    await transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Error handling message:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok",
    activeSessions: Object.keys(transports).length,
    memApiConfigured: !!MEM_API_KEY
  });
});

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "mem-mcp-server",
    version: "1.0.0",
    endpoints: {
      sse: "/sse",
      messages: "/messages",
      health: "/health"
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`MCP Mem.ai server running on port ${PORT}`);
  console.log(`SSE endpoint: /sse`);
  console.log(`Messages endpoint: /messages`);
  console.log(`Health check: /health`);
  console.log(`MEM_API_KEY configured: ${!!MEM_API_KEY}`);
});

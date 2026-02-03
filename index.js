import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import express from "express";
import { randomUUID } from "crypto";

const MEM_API_KEY = process.env.MEM_API_KEY;

// Store transports by sessionId for SSE connections
const sseTransports = {};
// Store transports by sessionId for Streamable HTTP connections  
const httpTransports = {};

// Function to call Mem.ai API v0 (for creating mems)
async function callMemAPIv0(endpoint, method = "GET", body = null) {
  const options = {
    method,
    headers: {
      "Authorization": `ApiAccessToken ${MEM_API_KEY}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`https://api.mem.ai/v0${endpoint}`, options);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Mem.ai API v0 error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return await response.json();
}

// Function to call Mem.ai API v2 (for mem-it endpoint)
async function callMemAPIv2(endpoint, method = "POST", body = null) {
  const options = {
    method,
    headers: {
      "Authorization": `Bearer ${MEM_API_KEY}`,
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(`https://api.mem.ai/v2${endpoint}`, options);
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Mem.ai API v2 error: ${response.status} ${response.statusText} - ${errorText}`);
  }

  return await response.json();
}

// Create a new MCP server instance
function createServer() {
  const server = new McpServer({
    name: "mem-mcp-server",
    version: "1.0.0",
  });

  // Register tools
  
  // mem_create - Create a new mem using v0 API
  server.tool(
    "mem_create",
    "Create a new note in Mem.ai",
    {
      content: z.string().describe("The content of the note to create"),
    },
    async ({ content }) => {
      try {
        const result = await callMemAPIv0("/mems", "POST", { content });
        return {
          content: [{ type: "text", text: `Note created successfully!\n\nID: ${result.id}\nCreated at: ${result.createdAt}\n\nContent: ${result.content}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error creating note: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // mem_it - Send content to Mem using v2 mem-it endpoint (intelligent processing)
  server.tool(
    "mem_search",
    "Send content to Mem.ai for intelligent processing and organization. Mem will automatically process, organize, and structure your input.",
    {
      query: z.string().describe("The content or query to send to Mem for processing"),
      limit: z.number().optional().default(10).describe("Not used - kept for compatibility"),
    },
    async ({ query }) => {
      try {
        const result = await callMemAPIv2("/mem-it", "POST", { 
          input: query,
          instructions: "Process this content and find relevant information"
        });
        return {
          content: [{ type: "text", text: `Content sent to Mem for processing!\n\nRequest ID: ${result.requestId || result.id || 'Processing'}\n\nNote: Mem processes content in the background. Your content will be intelligently organized and searchable in Mem.` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // mem_read - Read a specific mem by ID using v0 API
  server.tool(
    "mem_read",
    "Read a specific note by ID from Mem.ai",
    {
      note_id: z.string().describe("The ID of the note to read"),
    },
    async ({ note_id }) => {
      try {
        const result = await callMemAPIv0(`/mems/${note_id}`);
        return {
          content: [{ type: "text", text: `Note found!\n\nID: ${result.id}\nCreated at: ${result.createdAt}\n\nContent:\n${result.content}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error reading note: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // mem_append - Append content to an existing mem
  server.tool(
    "mem_append",
    "Append content to an existing note in Mem.ai",
    {
      note_id: z.string().describe("The ID of the note to append to"),
      content: z.string().describe("The content to append"),
    },
    async ({ note_id, content }) => {
      try {
        const result = await callMemAPIv0(`/mems/${note_id}/append`, "POST", { content });
        return {
          content: [{ type: "text", text: `Content appended successfully!\n\nNote ID: ${note_id}\n\nAppended content:\n${content}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error appending to note: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

// Create Express app
const app = express();

// Parse JSON bodies for POST requests
app.use(express.json());

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Accept, Cache-Control');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// ============================================
// Streamable HTTP Transport (Modern - /mcp)
// ============================================

app.all("/mcp", async (req, res) => {
  console.log(`MCP ${req.method} request received`);
  
  // Get or create session ID
  let sessionId = req.headers['mcp-session-id'];
  
  if (req.method === 'POST') {
    // Check if this is an initialize request (new session)
    const isInitialize = req.body?.method === 'initialize';
    
    if (isInitialize || !sessionId) {
      // Create new session
      sessionId = randomUUID();
      console.log(`Creating new Streamable HTTP session: ${sessionId}`);
      
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });
      
      httpTransports[sessionId] = { server, transport };
      
      // Connect server to transport
      await server.connect(transport);
      
      // Clean up on close
      res.on('close', () => {
        if (httpTransports[sessionId]) {
          console.log(`Cleaning up HTTP session: ${sessionId}`);
        }
      });
    }
    
    const session = httpTransports[sessionId];
    if (!session) {
      console.error(`No session found for: ${sessionId}`);
      return res.status(404).json({ error: "Session not found" });
    }
    
    // Set session ID header
    res.setHeader('Mcp-Session-Id', sessionId);
    
    try {
      await session.transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  } else if (req.method === 'GET') {
    // GET request for SSE stream (optional in Streamable HTTP)
    if (!sessionId) {
      return res.status(400).json({ error: "Missing Mcp-Session-Id header" });
    }
    
    const session = httpTransports[sessionId];
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    
    res.setHeader('Mcp-Session-Id', sessionId);
    
    try {
      await session.transport.handleRequest(req, res);
    } catch (error) {
      console.error("Error handling GET request:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Internal server error" });
      }
    }
  } else if (req.method === 'DELETE') {
    // Session termination
    if (sessionId && httpTransports[sessionId]) {
      delete httpTransports[sessionId];
      console.log(`Deleted HTTP session: ${sessionId}`);
    }
    res.sendStatus(204);
  } else {
    res.status(405).json({ error: "Method not allowed" });
  }
});

// ============================================
// Legacy SSE Transport (/sse + /messages)
// ============================================

app.get("/sse", async (req, res) => {
  console.log("SSE connection received");
  
  try {
    const server = createServer();
    const transport = new SSEServerTransport("/messages", res);
    
    sseTransports[transport.sessionId] = { server, transport };
    console.log(`Created SSE session: ${transport.sessionId}`);
    
    res.on("close", () => {
      console.log(`SSE session closed: ${transport.sessionId}`);
      delete sseTransports[transport.sessionId];
    });
    
    await server.connect(transport);
  } catch (error) {
    console.error("SSE connection error:", error);
    if (!res.headersSent) {
      res.status(500).send("Internal Server Error");
    }
  }
});

app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  console.log(`SSE message received for session: ${sessionId}`);
  
  if (!sessionId) {
    return res.status(400).json({ error: "Missing sessionId parameter" });
  }
  
  const session = sseTransports[sessionId];
  if (!session) {
    console.error(`No SSE transport found for session: ${sessionId}`);
    return res.status(404).json({ error: "Session not found" });
  }
  
  try {
    await session.transport.handlePostMessage(req, res);
  } catch (error) {
    console.error("Error handling SSE message:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// ============================================
// Info & Health Endpoints
// ============================================

app.get("/health", (req, res) => {
  res.json({ 
    status: "ok",
    sseActiveSessions: Object.keys(sseTransports).length,
    httpActiveSessions: Object.keys(httpTransports).length,
    memApiConfigured: !!MEM_API_KEY,
    version: "1.0.1",
    transports: ["streamable-http", "sse"],
    apiVersions: {
      v0: "Used for create, read, append operations",
      v2: "Used for mem-it intelligent processing"
    }
  });
});

app.get("/", (req, res) => {
  res.json({
    name: "mem-mcp-server",
    version: "1.0.1",
    description: "MCP server for Mem.ai",
    endpoints: {
      mcp: "/mcp (Streamable HTTP - recommended)",
      sse: "/sse (Legacy SSE)",
      messages: "/messages (Legacy SSE messages)",
      health: "/health"
    },
    tools: {
      mem_create: "Create a new note (v0 API)",
      mem_search: "Send content to Mem for intelligent processing (v2 mem-it API)",
      mem_read: "Read a specific note by ID (v0 API)",
      mem_append: "Append content to an existing note (v0 API)"
    },
    authentication: "none"
  });
});

// Catch-all for unknown routes
app.use((req, res) => {
  console.log(`404 for: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found", path: req.path });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP Mem.ai server running on port ${PORT}`);
  console.log(`Streamable HTTP endpoint: /mcp (recommended)`);
  console.log(`Legacy SSE endpoint: /sse`);
  console.log(`Health check: /health`);
  console.log(`MEM_API_KEY configured: ${!!MEM_API_KEY}`);
});

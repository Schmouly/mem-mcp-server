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

// Function to call Mem.ai API v2
async function callMemAPIv2(endpoint, method = "GET", body = null) {
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
    version: "2.0.1",
  });

  // =====================
  // NOTES TOOLS
  // =====================

  // mem_search - POST /v2/notes/search
  // Doc: https://docs.mem.ai/api-reference/notes/search-notes
  server.tool(
    "mem_search",
    "Search notes in Mem.ai using semantic search",
    {
      query: z.string().describe("The search query to find relevant notes"),
      filter_by_contains_open_tasks: z.boolean().optional().default(false).describe("Filter for notes with open tasks"),
    },
    async ({ query, filter_by_contains_open_tasks }) => {
      try {
        const body = { 
          query: query,
          config: {
            include_note_content: true
          }
        };
        
        if (filter_by_contains_open_tasks) {
          body.filter_by_contains_open_tasks = true;
        }
        
        const result = await callMemAPIv2("/notes/search", "POST", body);
        
        if (!result.results || result.results.length === 0) {
          return {
            content: [{ type: "text", text: `No notes found matching "${query}"` }],
          };
        }
        
        let responseText = `Found ${result.total} notes matching "${query}":\n\n`;
        
        for (const note of result.results) {
          responseText += `---\n`;
          responseText += `**${note.title || 'Untitled'}** (ID: ${note.id})\n`;
          responseText += `Created: ${note.created_at} | Updated: ${note.updated_at}\n`;
          if (note.snippet) {
            responseText += `Snippet: ${note.snippet}\n`;
          }
          if (note.content) {
            responseText += `Content:\n${note.content.substring(0, 500)}${note.content.length > 500 ? '...' : ''}\n`;
          }
          responseText += `\n`;
        }
        
        return {
          content: [{ type: "text", text: responseText }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error searching notes: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // mem_list - GET /v2/notes
  // Doc: https://docs.mem.ai/api-reference/notes/list-notes
  server.tool(
    "mem_list",
    "List notes from Mem.ai with optional filtering",
    {
      limit: z.number().optional().default(20).describe("Maximum number of notes to return (default: 20, max: 50)"),
      order_by: z.enum(["created_at", "updated_at"]).optional().default("updated_at").describe("Sort order"),
      contains_open_tasks: z.boolean().optional().default(false).describe("Filter for notes with open tasks"),
      include_content: z.boolean().optional().default(true).describe("Include note content in response"),
    },
    async ({ limit, order_by, contains_open_tasks, include_content }) => {
      try {
        // Build query string - these are query params, not body
        const params = new URLSearchParams();
        params.append('limit', String(limit || 20));
        params.append('order_by', order_by || 'updated_at');
        params.append('include_note_content', String(include_content !== false));
        if (contains_open_tasks) {
          params.append('contains_open_tasks', 'true');
        }
        
        const result = await callMemAPIv2(`/notes?${params.toString()}`, "GET");
        
        if (!result.results || result.results.length === 0) {
          return {
            content: [{ type: "text", text: "No notes found" }],
          };
        }
        
        let responseText = `Found ${result.total} notes:\n\n`;
        
        for (const note of result.results) {
          responseText += `---\n`;
          responseText += `**${note.title || 'Untitled'}** (ID: ${note.id})\n`;
          responseText += `Created: ${note.created_at} | Updated: ${note.updated_at}\n`;
          if (note.snippet) {
            responseText += `Snippet: ${note.snippet}\n`;
          }
          if (note.content) {
            responseText += `Content:\n${note.content.substring(0, 300)}${note.content.length > 300 ? '...' : ''}\n`;
          }
          responseText += `\n`;
        }
        
        if (result.next_page) {
          responseText += `\n(More notes available - use pagination to see more)`;
        }
        
        return {
          content: [{ type: "text", text: responseText }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error listing notes: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // mem_create - POST /v2/notes
  // Doc: https://docs.mem.ai/api-reference/notes/create-note
  server.tool(
    "mem_create",
    "Create a new note in Mem.ai",
    {
      content: z.string().describe("The markdown content of the note (first line becomes title, max ~200k chars)"),
      collection_titles: z.array(z.string()).optional().describe("Optional collection titles to add the note to"),
      collection_ids: z.array(z.string()).optional().describe("Optional collection IDs to add the note to"),
    },
    async ({ content, collection_titles, collection_ids }) => {
      try {
        const body = { content };
        if (collection_titles && collection_titles.length > 0) {
          body.collection_titles = collection_titles;
        }
        if (collection_ids && collection_ids.length > 0) {
          body.collection_ids = collection_ids;
        }
        
        const result = await callMemAPIv2("/notes", "POST", body);
        return {
          content: [{ type: "text", text: `Note created successfully!\n\nID: ${result.id}\nTitle: ${result.title}\nCreated at: ${result.created_at}\nCollections: ${result.collection_ids?.join(', ') || 'none'}` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error creating note: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // mem_read - GET /v2/notes/{note_id}
  // Doc: https://docs.mem.ai/api-reference/notes/read-note
  server.tool(
    "mem_read",
    "Read a specific note by ID from Mem.ai",
    {
      note_id: z.string().describe("The UUID of the note to read"),
    },
    async ({ note_id }) => {
      try {
        const result = await callMemAPIv2(`/notes/${note_id}`, "GET");
        return {
          content: [{ 
            type: "text", 
            text: `**${result.title || 'Untitled'}**\n\nID: ${result.id}\nCreated: ${result.created_at}\nUpdated: ${result.updated_at}\nCollections: ${result.collection_ids?.join(', ') || 'none'}\n\n---\n\n${result.content}` 
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error reading note: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // =====================
  // MEM IT TOOL
  // =====================

  // mem_it - POST /v2/mem-it
  // Doc: https://docs.mem.ai/api-reference/mem-it/mem-it
  server.tool(
    "mem_it",
    "Send content to Mem.ai for intelligent processing and organization (async)",
    {
      input: z.string().describe("The content to send to Mem for processing"),
      instructions: z.string().optional().describe("Optional instructions for how Mem should process the content"),
      context: z.string().optional().describe("Optional context about the content"),
    },
    async ({ input, instructions, context }) => {
      try {
        const body = { input };
        if (instructions) body.instructions = instructions;
        if (context) body.context = context;
        
        const result = await callMemAPIv2("/mem-it", "POST", body);
        return {
          content: [{ type: "text", text: `Content sent to Mem for processing!\n\nRequest ID: ${result.request_id}\n\nNote: Mem processes content asynchronously in the background.` }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // =====================
  // COLLECTIONS TOOLS
  // =====================

  // mem_collections_list - GET /v2/collections
  server.tool(
    "mem_collections_list",
    "List collections from Mem.ai",
    {
      limit: z.number().optional().default(20).describe("Maximum number of collections to return"),
    },
    async ({ limit }) => {
      try {
        const result = await callMemAPIv2(`/collections?limit=${limit || 20}`, "GET");
        
        if (!result.results || result.results.length === 0) {
          return {
            content: [{ type: "text", text: "No collections found" }],
          };
        }
        
        let responseText = `Found ${result.total} collections:\n\n`;
        
        for (const collection of result.results) {
          responseText += `- **${collection.title}** (ID: ${collection.id})\n`;
          if (collection.description) {
            responseText += `  Description: ${collection.description}\n`;
          }
        }
        
        return {
          content: [{ type: "text", text: responseText }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error listing collections: ${error.message}` }],
          isError: true,
        };
      }
    }
  );

  // mem_collections_search - POST /v2/collections/search
  server.tool(
    "mem_collections_search",
    "Search collections in Mem.ai",
    {
      query: z.string().describe("The search query for collections"),
    },
    async ({ query }) => {
      try {
        const result = await callMemAPIv2("/collections/search", "POST", { query });
        
        if (!result.results || result.results.length === 0) {
          return {
            content: [{ type: "text", text: `No collections found matching "${query}"` }],
          };
        }
        
        let responseText = `Found ${result.total} collections matching "${query}":\n\n`;
        
        for (const collection of result.results) {
          responseText += `- **${collection.title}** (ID: ${collection.id})\n`;
          if (collection.description) {
            responseText += `  Description: ${collection.description}\n`;
          }
        }
        
        return {
          content: [{ type: "text", text: responseText }],
        };
      } catch (error) {
        return {
          content: [{ type: "text", text: `Error searching collections: ${error.message}` }],
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
  
  let sessionId = req.headers['mcp-session-id'];
  
  if (req.method === 'POST') {
    const isInitialize = req.body?.method === 'initialize';
    
    if (isInitialize || !sessionId) {
      sessionId = randomUUID();
      console.log(`Creating new Streamable HTTP session: ${sessionId}`);
      
      const server = createServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => sessionId,
      });
      
      httpTransports[sessionId] = { server, transport };
      await server.connect(transport);
      
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
    version: "2.0.1",
    transports: ["streamable-http", "sse"],
    apiVersion: "v2",
    endpoints: {
      notes: "POST /v2/notes/search, GET /v2/notes, POST /v2/notes, GET /v2/notes/{id}, DELETE /v2/notes/{id}",
      memIt: "POST /v2/mem-it",
      collections: "GET /v2/collections, POST /v2/collections/search"
    }
  });
});

app.get("/", (req, res) => {
  res.json({
    name: "mem-mcp-server",
    version: "2.0.1",
    description: "MCP server for Mem.ai using v2 API",
    documentation: "https://docs.mem.ai/api-reference/overview/introduction",
    endpoints: {
      mcp: "/mcp (Streamable HTTP - recommended)",
      sse: "/sse (Legacy SSE)",
      messages: "/messages (Legacy SSE messages)",
      health: "/health"
    },
    tools: {
      mem_search: "POST /v2/notes/search - Search notes",
      mem_list: "GET /v2/notes - List notes with filters",
      mem_create: "POST /v2/notes - Create a new note",
      mem_read: "GET /v2/notes/{id} - Read a note by ID",
      mem_it: "POST /v2/mem-it - Intelligent content processing",
      mem_collections_list: "GET /v2/collections - List collections",
      mem_collections_search: "POST /v2/collections/search - Search collections"
    }
  });
});

app.use((req, res) => {
  console.log(`404 for: ${req.method} ${req.path}`);
  res.status(404).json({ error: "Not found", path: req.path });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`MCP Mem.ai server v2.0.1 running on port ${PORT}`);
  console.log(`Using Mem.ai API v2 - https://docs.mem.ai`);
  console.log(`Streamable HTTP: /mcp | SSE: /sse | Health: /health`);
  console.log(`MEM_API_KEY configured: ${!!MEM_API_KEY}`);
});

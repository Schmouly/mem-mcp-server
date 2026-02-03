import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import fetch from "node-fetch";
import { createServer } from "http";

const MEM_API_KEY = process.env.MEM_API_KEY;
const MEM_API_BASE = "https://api.mem.ai/v1";

// Créer le serveur MCP
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

// Fonction pour appeler l'API Mem.ai
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

// Lister les outils disponibles
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

// Gérer les appels d'outils
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

// Créer le serveur HTTP avec SSE
const httpServer = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  if (req.url === "/sse" && req.method === "GET") {
    console.log("SSE connection received");
    const transport = new SSEServerTransport("/sse", res);
    await server.connect(transport);
  } else if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
  console.log(`MCP Mem.ai server running on port ${PORT}`);
});

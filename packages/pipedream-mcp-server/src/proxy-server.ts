import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ToolRegistry } from "./tool-registry.js";
import { logger } from "./logger.js";

export async function startServer(registry: ToolRegistry): Promise<void> {
  const server = new Server(
    { name: "ccteams-pipedream-proxy", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Build the tools list including the meta-tool
  const allTools = registry.getAllTools();

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const tools = [
      {
        name: "list_integrations",
        description:
          "List all connected app integrations, their status, and available tool counts for this client",
        inputSchema: { type: "object" as const, properties: {} },
      },
      ...allTools.map((t) => ({
        name: t.prefixedName,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    ];

    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    // Handle meta-tool
    if (name === "list_integrations") {
      const summary = registry.getIntegrationsSummary();
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(summary, null, 2) },
        ],
      };
    }

    // Proxy to the right app
    try {
      const result = await registry.callTool(name, args ?? {});
      return {
        content: result.content as Array<{
          type: "text";
          text: string;
        }>,
        isError: result.isError,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Tool call failed: ${name}`, { error: message });
      return {
        content: [{ type: "text" as const, text: `Error: ${message}` }],
        isError: true,
      };
    }
  });

  logger.info(
    `Registered ${allTools.length + 1} tools (${allTools.length} proxy + 1 meta)`,
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  logger.info("MCP server ready on stdio");
}

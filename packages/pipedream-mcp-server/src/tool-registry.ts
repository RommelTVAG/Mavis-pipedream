import { AppClient, AppTool } from "./app-client.js";
import { AppConnection, TokenProvider } from "./types.js";
import { logger } from "./logger.js";

export interface RegisteredTool {
  prefixedName: string;
  appSlug: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface AppEntry {
  client: AppClient;
  connection: AppConnection;
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  private appClients = new Map<string, AppEntry>();
  private appStatuses: Array<{
    app: string;
    name: string;
    account: string | null;
    toolCount: number;
    status: "connected" | "failed";
    error?: string;
  }> = [];

  constructor(
    private auth: TokenProvider,
    private projectId: string,
    private environment: string,
    private externalUserId: string,
  ) {}

  async initialize(apps: Map<string, AppConnection>): Promise<void> {
    const connectPromises = [...apps.entries()].map(([slug, connection]) =>
      this.connectApp(slug, connection),
    );

    await Promise.allSettled(connectPromises);

    logger.info(
      `Tool registry ready: ${this.tools.size} tools across ${this.appClients.size} apps`,
    );
  }

  private async connectApp(
    slug: string,
    connection: AppConnection,
  ): Promise<void> {
    const client = new AppClient(
      slug,
      this.externalUserId,
      this.auth,
      this.projectId,
      this.environment,
    );

    try {
      await client.connect();
      const tools = await client.listTools();

      this.appClients.set(slug, { client, connection });

      for (const tool of tools) {
        const prefixedName = `${slug}-${tool.name}`;
        this.tools.set(prefixedName, {
          prefixedName,
          appSlug: slug,
          originalName: tool.name,
          description: `[${connection.name}] ${tool.description ?? ""}`,
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        });
      }

      this.appStatuses.push({
        app: slug,
        name: connection.name,
        account: connection.accountName,
        toolCount: tools.length,
        status: "connected",
      });

      logger.info(`Loaded ${tools.length} tools from ${slug}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to connect to ${slug}: ${message}`);

      this.appStatuses.push({
        app: slug,
        name: connection.name,
        account: connection.accountName,
        toolCount: 0,
        status: "failed",
        error: message,
      });
    }
  }

  getAllTools(): RegisteredTool[] {
    return [...this.tools.values()];
  }

  async callTool(
    prefixedName: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown[]; isError?: boolean }> {
    const tool = this.tools.get(prefixedName);
    if (!tool) {
      return {
        content: [{ type: "text", text: `Unknown tool: ${prefixedName}` }],
        isError: true,
      };
    }

    const entry = this.appClients.get(tool.appSlug);
    if (!entry) {
      return {
        content: [
          {
            type: "text",
            text: `App ${tool.appSlug} is not connected`,
          },
        ],
        isError: true,
      };
    }

    return entry.client.callTool(tool.originalName, args);
  }

  getIntegrationsSummary() {
    return {
      integrations: this.appStatuses,
      total_tools: this.tools.size,
      connected_apps: this.appClients.size,
      external_user_id: this.externalUserId,
    };
  }

  async close(): Promise<void> {
    const closePromises = [...this.appClients.values()].map((e) =>
      e.client.close(),
    );
    await Promise.allSettled(closePromises);
  }
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { TokenProvider } from "./types.js";
import { logger } from "./logger.js";

const REMOTE_URL = "https://remote.mcp.pipedream.net/v3";

export interface AppTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export class AppClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;

  constructor(
    private appSlug: string,
    private externalUserId: string,
    private auth: TokenProvider,
    private projectId: string,
    private environment: string,
  ) {}

  async connect(): Promise<void> {
    const url = new URL(REMOTE_URL);

    this.transport = new StreamableHTTPClientTransport(url, {
      fetch: async (input, init) => {
        const token = await this.auth.getToken();
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        headers.set("x-pd-project-id", this.projectId);
        headers.set("x-pd-environment", this.environment);
        headers.set("x-pd-external-user-id", this.externalUserId);
        headers.set("x-pd-app-slug", this.appSlug);
        return globalThis.fetch(input, { ...init, headers });
      },
    });

    this.client = new Client(
      { name: "ccteams-proxy", version: "1.0.0" },
      { capabilities: {} },
    );

    await this.client.connect(this.transport);
    logger.info(`Connected to ${this.appSlug} MCP endpoint`);
  }

  async listTools(): Promise<AppTool[]> {
    if (!this.client) throw new Error(`Not connected to ${this.appSlug}`);

    const result = await this.client.listTools();
    return result.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as Record<string, unknown>,
    }));
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ content: unknown[]; isError?: boolean }> {
    if (!this.client) throw new Error(`Not connected to ${this.appSlug}`);

    const result = await this.client.callTool({ name, arguments: args });
    return {
      content: result.content as unknown[],
      isError: typeof result.isError === "boolean" ? result.isError : false,
    };
  }

  async close(): Promise<void> {
    try {
      await this.transport?.close();
    } catch {
      // ignore close errors
    }
    this.client = null;
    this.transport = null;
  }
}

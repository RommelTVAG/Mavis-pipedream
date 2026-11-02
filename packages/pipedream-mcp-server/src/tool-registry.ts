import { AppClient, AppClientLike } from "./app-client.js";
import { AppAccount, AppConnection, TokenProvider } from "./types.js";
import { logger } from "./logger.js";

export interface RegisteredTool {
  prefixedName: string;
  appSlug: string;
  accountId: string;
  originalName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

interface AccountEntry {
  client: AppClientLike;
  connection: AppConnection;
  account: AppAccount;
}

type ClientFactory = (appSlug: string, accountId: string) => AppClientLike;

const MAX_KEY_LENGTH = 24;

/** `office@example.com` -> `office`: a short, tool-name-safe label for one account. */
function accountBase(name: string | null): string {
  const local = (name ?? "").split("@")[0] ?? "";
  return local
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_KEY_LENGTH)
    .replace(/_+$/, "");
}

/**
 * One tool-name key per account, unique within the app. Derived from the account name; an account
 * whose name is empty or shared with a sibling falls back to its Pipedream account id.
 */
export function accountKeys(accounts: AppAccount[]): string[] {
  const bases = accounts.map((a) => accountBase(a.name));
  const uses = new Map<string, number>();
  for (const b of bases) uses.set(b, (uses.get(b) ?? 0) + 1);
  return accounts.map((a, i) => (bases[i] && uses.get(bases[i]) === 1 ? bases[i]! : a.id));
}

export class ToolRegistry {
  private tools = new Map<string, RegisteredTool>();
  /** One pinned connection per (app, account), keyed `slug:accountId`. */
  private entries = new Map<string, AccountEntry>();
  private appStatuses: Array<{
    app: string;
    name: string;
    account: string | null;
    account_id: string;
    tool_prefix: string;
    toolCount: number;
    status: "connected" | "failed";
    error?: string;
  }> = [];
  private clientFactory: ClientFactory;

  constructor(
    private auth: TokenProvider,
    private projectId: string,
    private environment: string,
    private externalUserId: string,
    clientFactory?: ClientFactory,
  ) {
    this.clientFactory =
      clientFactory ??
      ((slug, accountId) =>
        new AppClient(slug, this.externalUserId, this.auth, this.projectId, this.environment, accountId));
  }

  async initialize(apps: Map<string, AppConnection>): Promise<void> {
    const connectPromises = [...apps.entries()].flatMap(([slug, connection]) => {
      const keys = accountKeys(connection.accounts);
      const multi = connection.accounts.length > 1;
      return connection.accounts.map((account, i) =>
        // A single-account app keeps its original tool names; several accounts get `<slug>-<key>-`.
        this.connectAccount(slug, connection, account, multi ? `${slug}-${keys[i]}-` : `${slug}-`, multi),
      );
    });

    await Promise.allSettled(connectPromises);

    logger.info(
      `Tool registry ready: ${this.tools.size} tools across ${this.entries.size} connected accounts`,
    );
  }

  private async connectAccount(
    slug: string,
    connection: AppConnection,
    account: AppAccount,
    prefix: string,
    multi: boolean,
  ): Promise<void> {
    const status = {
      app: slug,
      name: connection.name,
      account: account.name,
      account_id: account.id,
      tool_prefix: prefix,
    };
    const client = this.clientFactory(slug, account.id);

    try {
      await client.connect();
      const tools = await client.listTools();

      const entryKey = `${slug}:${account.id}`;
      this.entries.set(entryKey, { client, connection, account });

      const label = multi && account.name ? `${connection.name} · ${account.name}` : connection.name;
      for (const tool of tools) {
        const prefixedName = `${prefix}${tool.name}`;
        this.tools.set(prefixedName, {
          prefixedName,
          appSlug: slug,
          accountId: account.id,
          originalName: tool.name,
          description: `[${label}] ${tool.description ?? ""}`,
          inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        });
      }

      this.appStatuses.push({ ...status, toolCount: tools.length, status: "connected" });

      logger.info(`Loaded ${tools.length} tools from ${slug}`, { accountId: account.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error(`Failed to connect to ${slug}: ${message}`, { accountId: account.id });
      await client.close().catch(() => {});

      this.appStatuses.push({ ...status, toolCount: 0, status: "failed", error: message });
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

    const entry = this.entries.get(`${tool.appSlug}:${tool.accountId}`);
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
    const integrations = [...this.appStatuses].sort(
      (a, b) => a.app.localeCompare(b.app) || a.tool_prefix.localeCompare(b.tool_prefix),
    );
    return {
      integrations,
      total_tools: this.tools.size,
      connected_apps: new Set([...this.entries.values()].map((e) => e.connection.slug)).size,
      connected_accounts: this.entries.size,
      external_user_id: this.externalUserId,
    };
  }

  async close(): Promise<void> {
    const closePromises = [...this.entries.values()].map((e) =>
      e.client.close(),
    );
    await Promise.allSettled(closePromises);
  }
}

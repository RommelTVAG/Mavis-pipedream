import type { Env } from "./env.js";

const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

export interface ConnectTokenResult {
  connectLinkUrl: string;
  expiresAt: string;
}

export interface ConnectedAccount {
  id: string;
  appSlug: string;
  appName: string;
  healthy: boolean;
}

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

export class PipedreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Server-side Pipedream client. The only place the project client secret is used. */
export class PipedreamClient {
  private cached: CachedToken | null = null;
  private inflight: Promise<CachedToken> | null = null;

  constructor(
    private env: Env,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  get projectId(): string {
    return this.env.PIPEDREAM_PROJECT_ID;
  }

  get environment(): string {
    return this.env.PIPEDREAM_PROJECT_ENVIRONMENT;
  }

  /** Project access token plus seconds until expiry. Cached and refreshed 5 minutes early. */
  async getAccessToken(): Promise<{ accessToken: string; expiresIn: number }> {
    const t = await this.token();
    return { accessToken: t.accessToken, expiresIn: Math.max(0, Math.floor((t.expiresAt - Date.now()) / 1000)) };
  }

  private async token(): Promise<CachedToken> {
    if (this.cached && Date.now() < this.cached.expiresAt - EXPIRY_MARGIN_MS) return this.cached;
    if (!this.inflight) {
      this.inflight = this.mint().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async mint(): Promise<CachedToken> {
    const res = await this.fetchImpl(`${this.env.PIPEDREAM_API_BASE}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.env.PIPEDREAM_CLIENT_ID,
        client_secret: this.env.PIPEDREAM_CLIENT_SECRET,
      }),
    });
    if (!res.ok) throw new PipedreamError("Pipedream token request failed", res.status);
    const data = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return this.cached;
  }

  private async headers(): Promise<Record<string, string>> {
    const { accessToken } = await this.getAccessToken();
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "x-pd-environment": this.env.PIPEDREAM_PROJECT_ENVIRONMENT,
    };
  }

  async createConnectToken(externalUserId: string, redirectUri?: string): Promise<ConnectTokenResult> {
    const body: Record<string, string> = { external_user_id: externalUserId };
    if (redirectUri) {
      body.success_redirect_uri = redirectUri;
      body.error_redirect_uri = redirectUri;
    }
    const res = await this.fetchImpl(`${this.env.PIPEDREAM_API_BASE}/connect/${this.projectId}/tokens`, {
      method: "POST",
      headers: await this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new PipedreamError("Pipedream connect token request failed", res.status);
    const data = (await res.json()) as { connect_link_url: string; expires_at: string };
    return { connectLinkUrl: data.connect_link_url, expiresAt: data.expires_at };
  }

  async listAccounts(externalUserId: string): Promise<ConnectedAccount[]> {
    const url = new URL(`${this.env.PIPEDREAM_API_BASE}/connect/${this.projectId}/accounts`);
    url.searchParams.set("external_user_id", externalUserId);
    url.searchParams.set("limit", "100");
    const res = await this.fetchImpl(url, { headers: await this.headers() });
    if (!res.ok) throw new PipedreamError("Pipedream list accounts failed", res.status);
    const data = (await res.json()) as {
      data: Array<{ id: string; healthy: boolean; dead: boolean | null; app: { name_slug: string; name: string } }>;
    };
    return data.data
      .filter((a) => !a.dead)
      .map((a) => ({ id: a.id, appSlug: a.app.name_slug, appName: a.app.name, healthy: a.healthy }));
  }
}

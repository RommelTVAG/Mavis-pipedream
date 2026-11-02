import { assertSafeBrokerUrl } from "../credentials.js";

export interface AllowedClient {
  id: string;
  name: string;
}

export interface IssuedClient extends AllowedClient {
  token: string;
}

export interface ConnectedApp {
  id: string;
  appSlug: string;
  appName: string;
  healthy: boolean;
}

export class BrokerHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Setup-side broker calls. Uses the setup-code secret during enrollment, install tokens afterwards. */
export class BrokerClient {
  private base: URL;

  constructor(
    brokerUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {
    this.base = assertSafeBrokerUrl(brokerUrl);
  }

  private async post<T>(path: string, bearer: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(new URL(path, this.base), {
        method: "POST",
        headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new BrokerHttpError(0, "unreachable", `Cannot reach the broker: ${err instanceof Error ? err.message : String(err)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & Record<string, unknown>;
    if (!res.ok) {
      throw new BrokerHttpError(res.status, data.error ?? "error", data.message ?? `Broker returned ${res.status}`);
    }
    return data as T;
  }

  enroll(secret: string): Promise<{ label: string; clients: AllowedClient[]; selected: string[] }> {
    return this.post("/api/enroll", secret);
  }

  async select(secret: string, clientIds: string[]): Promise<IssuedClient[]> {
    return (await this.post<{ clients: IssuedClient[] }>("/api/select", secret, { clientIds })).clients;
  }

  finalize(secret: string): Promise<{ sealed: boolean }> {
    return this.post("/api/finalize", secret);
  }

  async connectToken(installToken: string, opts: { redirectUri: string; app: string }): Promise<string> {
    return (await this.post<{ connectLinkUrl: string }>("/api/connect-token", installToken, opts)).connectLinkUrl;
  }

  async accounts(installToken: string): Promise<ConnectedApp[]> {
    return (await this.post<{ accounts: ConnectedApp[] }>("/api/accounts", installToken)).accounts;
  }
}

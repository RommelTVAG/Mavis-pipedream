import { TokenProvider } from "./types.js";
import { logger } from "./logger.js";
import { assertSafeBrokerUrl } from "./credentials.js";

const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface BrokerSession {
  accessToken: string;
  expiresAt: number;
  projectId: string;
  environment: string;
  externalUserId: string;
  clientName: string;
}

interface AccessTokenResponse {
  accessToken: string;
  expiresIn: number;
  projectId: string;
  environment: string;
  externalUserId: string;
  clientName: string;
  renewedToken?: string;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/**
 * Gets Pipedream access tokens from the broker using this install's token, so the Pipedream
 * client secret never exists on this machine.
 */
export class BrokerAuthManager implements TokenProvider {
  private session: BrokerSession | null = null;
  private inflight: Promise<BrokerSession> | null = null;

  constructor(
    private brokerUrl: string,
    private installToken: string,
    private onTokenRenewed?: (token: string) => void,
    private fetchImpl: typeof fetch = fetch,
  ) {
    assertSafeBrokerUrl(brokerUrl);
  }

  async getToken(): Promise<string> {
    return (await this.getSession()).accessToken;
  }

  async getSession(): Promise<BrokerSession> {
    if (this.session && Date.now() < this.session.expiresAt - REFRESH_MARGIN_MS) return this.session;
    if (!this.inflight) {
      this.inflight = this.refresh().finally(() => {
        this.inflight = null;
      });
    }
    return this.inflight;
  }

  private async refresh(): Promise<BrokerSession> {
    logger.info("Requesting access token from broker");
    let res: Response;
    try {
      res = await this.fetchImpl(new URL("/api/access-token", this.brokerUrl), {
        method: "POST",
        headers: { Authorization: `Bearer ${this.installToken}` },
      });
    } catch (err) {
      throw new BrokerError(`Cannot reach the broker at ${this.brokerUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (res.status === 401 || res.status === 403) {
      throw new BrokerError(
        "The broker rejected this install (revoked, expired, or client no longer allowed). Ask your admin for a new setup code.",
        res.status,
      );
    }
    if (!res.ok) throw new BrokerError(`Broker returned ${res.status}`, res.status);

    const data = (await res.json()) as AccessTokenResponse;
    this.session = {
      accessToken: data.accessToken,
      expiresAt: Date.now() + data.expiresIn * 1000,
      projectId: data.projectId,
      environment: data.environment,
      externalUserId: data.externalUserId,
      clientName: data.clientName,
    };

    if (data.renewedToken) {
      this.installToken = data.renewedToken;
      try {
        this.onTokenRenewed?.(data.renewedToken);
        logger.info("Install token renewed");
      } catch (err) {
        logger.warn("Could not persist renewed install token", { error: err instanceof Error ? err.message : String(err) });
      }
    }
    return this.session;
  }
}

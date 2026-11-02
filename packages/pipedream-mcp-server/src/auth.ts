import { TokenData, TokenProvider } from "./types.js";
import { logger } from "./logger.js";

const TOKEN_URL = "https://api.pipedream.com/v1/oauth/token";
const REFRESH_MARGIN_MS = 5 * 60 * 1000; // refresh 5 minutes before expiry

export class AuthManager implements TokenProvider {
  private token: TokenData | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private clientId: string,
    private clientSecret: string,
  ) {}

  async getToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - REFRESH_MARGIN_MS) {
      return this.token.accessToken;
    }

    // Prevent concurrent refresh requests
    if (this.refreshPromise) {
      return this.refreshPromise;
    }

    this.refreshPromise = this.refresh();
    try {
      return await this.refreshPromise;
    } finally {
      this.refreshPromise = null;
    }
  }

  private async refresh(): Promise<string> {
    logger.info("Refreshing Pipedream OAuth token");

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: this.clientId,
        client_secret: this.clientSecret,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Token refresh failed (${res.status}): ${body}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    this.token = {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };

    logger.info("Token refreshed", { expiresIn: data.expires_in });
    return this.token.accessToken;
  }
}

import { AppConnection, PipedreamListResponse, TokenProvider } from "./types.js";
import { logger } from "./logger.js";

const API_BASE = "https://api.pipedream.com/v1/connect";

export async function discoverApps(
  auth: TokenProvider,
  projectId: string,
  environment: string,
  externalUserId: string,
): Promise<Map<string, AppConnection>> {
  const apps = new Map<string, AppConnection>();
  let cursor: string | undefined;

  do {
    const token = await auth.getToken();
    const url = new URL(`${API_BASE}/${projectId}/accounts`);
    url.searchParams.set("external_user_id", externalUserId);
    url.searchParams.set("limit", "100");
    if (cursor) {
      url.searchParams.set("after", cursor);
    }

    const res = await fetch(url.toString(), {
      headers: {
        Authorization: `Bearer ${token}`,
        "x-pd-environment": environment,
      },
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`List accounts failed (${res.status}): ${body}`);
    }

    const data = (await res.json()) as PipedreamListResponse;

    for (const account of data.data) {
      if (account.dead || !account.healthy) {
        logger.warn(`Skipping unhealthy account`, {
          app: account.app.name_slug,
          accountId: account.id,
          healthy: account.healthy,
          dead: account.dead,
        });
        continue;
      }

      const slug = account.app.name_slug;
      const existing = apps.get(slug);

      const entry = { id: account.id, name: account.name?.trim() || null };
      if (existing) {
        existing.accounts.push(entry);
      } else {
        apps.set(slug, {
          slug,
          name: account.app.name,
          accounts: [entry],
          healthy: true,
          authType: account.app.auth_type,
        });
      }
    }

    cursor = data.page_info.end_cursor;
    // Stop if we got fewer than the limit (last page)
    if (data.data.length < 100) {
      cursor = undefined;
    }
  } while (cursor);

  logger.info(`Discovered ${apps.size} apps for user ${externalUserId}`, {
    apps: [...apps.keys()],
  });

  return apps;
}

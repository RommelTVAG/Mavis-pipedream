import type { TokenProvider } from "../types.js";

const API = "https://api.pipedream.com/v1/connect";
const PAGE = 100;
/** Safety cap: 100 pages x 100 accounts. */
const MAX_PAGES = 100;

export interface DiscoveredClient {
  /** Pipedream external_user_id. */
  id: string;
  /**
   * Best human-readable name: the most common email-like account name for this user, else the most
   * common account name, else the id. Pipedream has no user-level profile, so this comes from the
   * names of the accounts the user connected (an email for Gmail, a username for GitHub, and so on).
   */
  label: string;
  /** Distinct account names, best first (email-like before others, then by how many accounts use them). */
  names: string[];
  /** Healthy connected apps (slugs), sorted. */
  apps: string[];
  /** Accounts Pipedream reports as unhealthy or dead. */
  unhealthy: number;
  /** Total connected accounts, healthy or not. */
  accounts: number;
  /** Most recent account update (ISO 8601), to tell apart clients that share a name. */
  lastUpdated: string | null;
}

interface RawAccount {
  external_id: string;
  name: string | null;
  updated_at?: string;
  healthy: boolean;
  dead: boolean | null;
  app: { name_slug: string };
}

/**
 * Every external user that has at least one connected account in the project. Pipedream has no "list
 * users" endpoint, so this walks the project's accounts and groups them.
 */
export async function listClients(
  auth: TokenProvider,
  projectId: string,
  environment: string,
  fetchImpl: typeof fetch = fetch,
  onProgress?: (accountsRead: number) => void,
): Promise<DiscoveredClient[]> {
  const byUser = new Map<string, { apps: Set<string>; unhealthy: number; names: Map<string, number>; accounts: number; last: number }>();
  let read = 0;
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`${API}/${projectId}/accounts`);
    url.searchParams.set("limit", String(PAGE));
    if (cursor) url.searchParams.set("after", cursor);

    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${await auth.getToken()}`, "x-pd-environment": environment },
    });
    if (!res.ok) throw new Error(`Pipedream list accounts failed (${res.status})`);
    const body = (await res.json()) as { data: RawAccount[]; page_info: { end_cursor?: string } };

    for (const a of body.data) {
      const entry = byUser.get(a.external_id) ?? { apps: new Set<string>(), unhealthy: 0, names: new Map<string, number>(), accounts: 0, last: 0 };
      entry.accounts += 1;
      const updated = a.updated_at ? Date.parse(a.updated_at) : NaN;
      if (Number.isFinite(updated)) entry.last = Math.max(entry.last, updated);
      const name = a.name?.trim();
      if (name) entry.names.set(name, (entry.names.get(name) ?? 0) + 1);
      if (a.dead || !a.healthy) entry.unhealthy += 1;
      else entry.apps.add(a.app.name_slug);
      byUser.set(a.external_id, entry);
    }

    read += body.data.length;
    onProgress?.(read);
    cursor = body.page_info.end_cursor;
    if (body.data.length < PAGE || !cursor) break;
  }

  return [...byUser.entries()]
    .map(([id, v]) => {
      const names = rankNames(v.names);
      return {
        id,
        label: names[0] ?? id,
        names,
        apps: [...v.apps].sort(),
        unhealthy: v.unhealthy,
        accounts: v.accounts,
        lastUpdated: v.last ? new Date(v.last).toISOString() : null,
      };
    })
    .sort((a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()) || a.id.localeCompare(b.id));
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Email-like names first, then most-used, then alphabetical (stable). */
function rankNames(counts: Map<string, number>): string[] {
  return [...counts.entries()]
    .sort(([an, ac], [bn, bc]) => Number(EMAIL.test(bn)) - Number(EMAIL.test(an)) || bc - ac || an.localeCompare(bn))
    .map(([n]) => n);
}

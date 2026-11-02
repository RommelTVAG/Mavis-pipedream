import type { Credentials, StoredClient } from "../credentials.js";

export function slugify(name: string, max = 40): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return base || "client";
}

export function uniqueSlug(name: string, taken: Set<string>): string {
  const base = slugify(name);
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base}-${i}`;
  return slug;
}

export interface NewClient {
  id: string;
  name: string;
  token: string;
}

/**
 * Adds newly installed clients to whatever is already on this machine. A client that was already
 * installed keeps its slug (so the registered MCP server name stays valid) and just gets a new token.
 */
export function mergeCredentials(
  existing: Credentials | null,
  broker: string,
  added: NewClient[],
  sealed: boolean,
): Credentials {
  if (existing && existing.broker !== broker) {
    throw new Error(`This machine is already set up against ${existing.broker}; refusing to mix in ${broker}.`);
  }
  const clients: StoredClient[] = existing ? existing.clients.map((c) => ({ ...c })) : [];
  const taken = new Set(clients.map((c) => c.slug));

  for (const n of added) {
    const current = clients.find((c) => c.id === n.id);
    if (current) {
      current.token = n.token;
      current.name = n.name;
    } else {
      const slug = uniqueSlug(n.name, taken);
      taken.add(slug);
      clients.push({ id: n.id, name: n.name, slug, token: n.token });
    }
  }
  return { version: 1, broker, sealed: sealed || (existing?.sealed ?? false), clients };
}

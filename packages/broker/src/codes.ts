import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.js";

export interface ClientEntry {
  /** Pipedream external_user_id. */
  id: string;
  name: string;
}

export type CodeStatus = "open" | "finalized" | "revoked";

export interface CodeRecord {
  id: string;
  /** sha256 hex of the setup-code secret. The secret itself is never stored. */
  hash: string;
  label: string;
  clients: ClientEntry[];
  status: CodeStatus;
  /** Clients the operator chose. Install tokens only work for these. */
  selected: string[];
  createdAt: string;
  finalizedAt?: string;
}

const PREFIX = "mavis_";
export const CLIENT_ID_PATTERN = /^[A-Za-z0-9_.@:-]{1,128}$/;

export const recordKey = (id: string): string => `code:${id}`;
export const CODE_INDEX_KEY = "codes";

export function hashSecret(secret: string): { id: string; hash: string } {
  const hash = createHash("sha256").update(secret).digest("hex");
  return { id: hash.slice(0, 32), hash };
}

/** A setup code bundles the broker URL and a one-time secret into one pasteable string. */
export function encodeSetupCode(brokerUrl: string, secret: string): string {
  return PREFIX + Buffer.from(JSON.stringify({ v: 1, b: brokerUrl, s: secret }), "utf8").toString("base64url");
}

export function decodeSetupCode(code: string): { broker: string; secret: string } | null {
  if (!code.startsWith(PREFIX)) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(code.slice(PREFIX.length), "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (p.v !== 1 || typeof p.b !== "string" || typeof p.s !== "string" || !p.s) return null;
    return { broker: p.b, secret: p.s };
  } catch {
    return null;
  }
}

export function generateSecret(): string {
  return randomBytes(32).toString("base64url");
}

export async function createCode(
  store: Store,
  opts: { label: string; clients: ClientEntry[]; brokerUrl: string },
): Promise<{ code: string; record: CodeRecord }> {
  if (opts.clients.length === 0) throw new Error("A setup code needs at least one client");
  const seen = new Set<string>();
  for (const c of opts.clients) {
    if (!CLIENT_ID_PATTERN.test(c.id)) throw new Error(`Invalid client id: ${c.id}`);
    if (seen.has(c.id)) throw new Error(`Duplicate client id: ${c.id}`);
    seen.add(c.id);
  }

  const secret = generateSecret();
  const { id, hash } = hashSecret(secret);
  const record: CodeRecord = {
    id,
    hash,
    label: opts.label,
    clients: opts.clients,
    status: "open",
    selected: [],
    createdAt: new Date().toISOString(),
  };
  await store.set(recordKey(id), record);
  await store.sadd(CODE_INDEX_KEY, id);
  return { code: encodeSetupCode(opts.brokerUrl, secret), record };
}

/** Look up a record by its secret. Constant-time hash comparison. */
export async function findBySecret(store: Store, secret: string): Promise<CodeRecord | null> {
  const { id, hash } = hashSecret(secret);
  const record = await store.get<CodeRecord>(recordKey(id));
  if (!record) return null;
  const a = Buffer.from(record.hash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return record;
}

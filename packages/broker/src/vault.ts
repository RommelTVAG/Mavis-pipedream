import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Store } from "./store.js";

/** Crockford base32: no I, L, O, U, so a key read aloud or typed from a screenshot survives. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const KEY_CHARS = 25; // 25 x 5 bits = 125 bits of entropy

export type VaultKeyStatus = "active" | "revoked";

/** One record per CSA key. Only a hash of the key is stored. */
export interface VaultKeyRecord {
  id: string;
  hash: string;
  label: string;
  status: VaultKeyStatus;
  createdAt: string;
  expiresAt?: string;
}

/** Written only by the server, so it can never overwrite what the admin CLI wrote (such as a revocation). */
export interface VaultUsage {
  uses: number;
  lastUsedAt?: string;
}

export type VaultKeyView = VaultKeyRecord & VaultUsage;

export type KeyLookup =
  | { ok: true; record: VaultKeyRecord }
  | { ok: false; reason: "malformed" | "unknown" | "revoked" | "expired" };

const recordKey = (id: string): string => `vkey:${id}`;
const usageKey = (id: string): string => `vuse:${id}`;
export const VAULT_INDEX_KEY = "vkeys";

/** XXXXX-XXXXX-XXXXX-XXXXX-XXXXX */
export function generateKey(): string {
  const chars = Array.from(randomBytes(KEY_CHARS), (b) => ALPHABET[b & 31]).join("");
  return (chars.match(/.{5}/g) as string[]).join("-");
}

/** Forgives case, spaces, dashes and the look-alike letters I, L, O. Returns null when it cannot be a key. */
export function normalizeKey(input: string): string | null {
  const k = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return k.length === KEY_CHARS && [...k].every((c) => ALPHABET.includes(c)) ? k : null;
}

/** 125 random bits do not need a slow KDF; a plain hash is enough and keeps lookups cheap. */
export function hashKey(normalized: string): { id: string; hash: string } {
  const hash = createHash("sha256").update(`mavis-vault-key:${normalized}`).digest("hex");
  return { id: hash.slice(0, 16), hash };
}

export async function issueKey(
  store: Store,
  opts: { label: string; expiresInDays?: number },
  now: number = Date.now(),
): Promise<{ key: string; record: VaultKeyRecord }> {
  const label = opts.label.trim();
  if (!label) throw new Error("A key needs a label (who it is for)");
  const key = generateKey();
  const { id, hash } = hashKey(normalizeKey(key) as string);
  const record: VaultKeyRecord = {
    id,
    hash,
    label,
    status: "active",
    createdAt: new Date(now).toISOString(),
    expiresAt: opts.expiresInDays ? new Date(now + opts.expiresInDays * 86_400_000).toISOString() : undefined,
  };
  await store.set(recordKey(id), record);
  await store.sadd(VAULT_INDEX_KEY, id);
  return { key, record };
}

/** Looks a typed key up. The caller must give the same answer for every failure reason. */
export async function findKey(store: Store, input: string, now: number = Date.now()): Promise<KeyLookup> {
  const normalized = normalizeKey(input);
  if (!normalized) return { ok: false, reason: "malformed" };
  const { id, hash } = hashKey(normalized);
  const record = await store.get<VaultKeyRecord>(recordKey(id));
  if (!record) return { ok: false, reason: "unknown" };
  const a = Buffer.from(record.hash, "hex");
  const b = Buffer.from(hash, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: "unknown" };
  if (record.status === "revoked") return { ok: false, reason: "revoked" };
  if (record.expiresAt && Date.parse(record.expiresAt) <= now) return { ok: false, reason: "expired" };
  return { ok: true, record };
}

export async function recordUse(store: Store, record: VaultKeyRecord, now: number = Date.now()): Promise<void> {
  const prev = (await store.get<VaultUsage>(usageKey(record.id))) ?? { uses: 0 };
  await store.set(usageKey(record.id), { uses: prev.uses + 1, lastUsedAt: new Date(now).toISOString() });
}

export async function revokeKey(store: Store, id: string): Promise<VaultKeyRecord | null> {
  const record = await store.get<VaultKeyRecord>(recordKey(id));
  if (!record) return null;
  const updated: VaultKeyRecord = { ...record, status: "revoked" };
  await store.set(recordKey(id), updated);
  return updated;
}

export async function listKeys(store: Store): Promise<VaultKeyView[]> {
  const ids = await store.smembers(VAULT_INDEX_KEY);
  const views = await Promise.all(
    ids.map(async (id) => {
      const record = await store.get<VaultKeyRecord>(recordKey(id));
      if (!record) return null;
      const usage = (await store.get<VaultUsage>(usageKey(id))) ?? { uses: 0 };
      return { ...record, ...usage };
    }),
  );
  return views.filter((v): v is VaultKeyView => v !== null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

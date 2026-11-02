import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Redis } from "@upstash/redis";
import { parseStoreEnv } from "./env.js";

export interface Store {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  del(key: string): Promise<void>;
  sadd(key: string, member: string): Promise<void>;
  smembers(key: string): Promise<string[]>;
  /** Increment a counter; first increment sets the TTL. Returns the new value. */
  incr(key: string, ttlSeconds: number): Promise<number>;
}

export class UpstashStore implements Store {
  private redis: Redis;

  constructor(source: Record<string, string | undefined> = process.env) {
    const { url, token } = parseStoreEnv(source);
    this.redis = new Redis({ url, token });
  }

  get<T>(key: string): Promise<T | null> {
    return this.redis.get<T>(key);
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.redis.set(key, value);
  }

  async del(key: string): Promise<void> {
    await this.redis.del(key);
  }

  async sadd(key: string, member: string): Promise<void> {
    await this.redis.sadd(key, member);
  }

  smembers(key: string): Promise<string[]> {
    return this.redis.smembers(key);
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const n = await this.redis.incr(key);
    if (n === 1) await this.redis.expire(key, ttlSeconds);
    return n;
  }
}

/** In-memory store for tests and the local dev server. Not for production: it does not persist. */
export class MemoryStore implements Store {
  private data = new Map<string, string>();
  private sets = new Map<string, Set<string>>();
  private counters = new Map<string, { n: number; resetAt: number }>();

  async get<T>(key: string): Promise<T | null> {
    const raw = this.data.get(key);
    return raw === undefined ? null : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, JSON.stringify(value));
  }

  async del(key: string): Promise<void> {
    this.data.delete(key);
  }

  async sadd(key: string, member: string): Promise<void> {
    const s = this.sets.get(key) ?? new Set<string>();
    s.add(member);
    this.sets.set(key, s);
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    const cur = this.counters.get(key);
    if (!cur || cur.resetAt <= now) {
      this.counters.set(key, { n: 1, resetAt: now + ttlSeconds * 1000 });
      return 1;
    }
    cur.n += 1;
    return cur.n;
  }
}

/**
 * Directory store for the VPS: one small file per record, written atomically (temp file + rename), 0600.
 * Reads always go to disk, so another process (the admin CLI issuing or revoking a key) is seen by the
 * running server immediately, and two processes never overwrite each other's records. Rate-limit
 * counters stay in memory: they are short-lived and would otherwise write on every request.
 */
export class FileStore implements Store {
  private counters = new Map<string, { n: number; resetAt: number }>();

  constructor(private dir: string) {
    for (const sub of ["kv", "sets"]) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
  }

  private file(kind: "kv" | "sets", key: string): string {
    return join(this.dir, kind, Buffer.from(key, "utf8").toString("base64url") + ".json");
  }

  private read<T>(path: string): T | null {
    try {
      return JSON.parse(readFileSync(path, "utf8")) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  private write(path: string, value: unknown): void {
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    renameSync(tmp, path);
  }

  async get<T>(key: string): Promise<T | null> {
    return this.read<T>(this.file("kv", key));
  }

  async set(key: string, value: unknown): Promise<void> {
    this.write(this.file("kv", key), value);
  }

  async del(key: string): Promise<void> {
    rmSync(this.file("kv", key), { force: true });
  }

  async sadd(key: string, member: string): Promise<void> {
    const path = this.file("sets", key);
    const members = this.read<string[]>(path) ?? [];
    if (!members.includes(member)) this.write(path, [...members, member]);
  }

  async smembers(key: string): Promise<string[]> {
    return this.read<string[]>(this.file("sets", key)) ?? [];
  }

  async incr(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    const cur = this.counters.get(key);
    if (!cur || cur.resetAt <= now) {
      this.counters.set(key, { n: 1, resetAt: now + ttlSeconds * 1000 });
      return 1;
    }
    cur.n += 1;
    return cur.n;
  }
}

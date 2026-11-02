import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface StoredClient {
  /** Pipedream external_user_id. Informational: the broker takes the real one from the token. */
  id: string;
  name: string;
  /** Used in the MCP server name and `--client <slug>`. */
  slug: string;
  /** Broker-signed install token. Not a Pipedream secret. */
  token: string;
}

export interface Credentials {
  version: 1;
  broker: string;
  /** True once the operator has locked their client selection. */
  sealed: boolean;
  clients: StoredClient[];
}

export function credentialsDir(): string {
  return process.env.MAVIS_HOME ?? join(homedir(), ".mavis-pipedream");
}

export function credentialsPath(): string {
  return join(credentialsDir(), "credentials.json");
}

export function readCredentials(): Credentials | null {
  const path = credentialsPath();
  if (!existsSync(path)) return null;
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isCredentials(parsed)) throw new Error(`Credentials file is malformed: ${path}. Re-run setup.`);
  return parsed;
}

/** Atomic write; directory 0700, file 0600. */
function writePrivateJson(file: string, value: unknown): void {
  const dir = credentialsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const tmp = join(dir, `${file}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  renameSync(tmp, join(dir, file));
}

export function writeCredentials(creds: Credentials): void {
  writePrivateJson("credentials.json", creds);
}

export function updateClientToken(slug: string, token: string): void {
  const creds = readCredentials();
  if (!creds) return;
  const client = creds.clients.find((c) => c.slug === slug);
  if (!client) return;
  client.token = token;
  writeCredentials(creds);
}

function isCredentials(v: unknown): v is Credentials {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    c.version === 1 &&
    typeof c.broker === "string" &&
    typeof c.sealed === "boolean" &&
    Array.isArray(c.clients) &&
    c.clients.every((x) => {
      const k = x as Record<string, unknown>;
      return (
        typeof k === "object" &&
        k !== null &&
        typeof k.id === "string" &&
        typeof k.name === "string" &&
        typeof k.slug === "string" &&
        typeof k.token === "string"
      );
    })
  );
}

/** Tokens are sent to this URL, so require TLS except for a local dev broker. */
export function assertSafeBrokerUrl(raw: string): URL {
  const url = new URL(raw);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`Broker URL must use https (got ${url.protocol}//${url.hostname})`);
  }
  return url;
}

/**
 * Local (development) install: the Pipedream client ID and secret are stored on this machine and the
 * MCP proxy talks to Pipedream directly. Used instead of the broker.
 */
export interface LocalConfig {
  version: 1;
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  /** Installed clients. `id` is the Pipedream external_user_id, `slug` names the MCP server. */
  clients: Array<{ id: string; slug: string }>;
}

export function localConfigPath(): string {
  return join(credentialsDir(), "local.json");
}

export function readLocalConfig(): LocalConfig | null {
  const path = localConfigPath();
  if (!existsSync(path)) return null;
  const v: unknown = JSON.parse(readFileSync(path, "utf8"));
  const c = v as Record<string, unknown>;
  const ok =
    typeof v === "object" &&
    v !== null &&
    c.version === 1 &&
    typeof c.clientId === "string" &&
    typeof c.clientSecret === "string" &&
    typeof c.projectId === "string" &&
    typeof c.environment === "string" &&
    Array.isArray(c.clients);
  if (!ok) throw new Error(`Local config is malformed: ${path}. Re-run setup.`);
  return v as LocalConfig;
}

export function writeLocalConfig(config: LocalConfig): void {
  writePrivateJson("local.json", config);
}

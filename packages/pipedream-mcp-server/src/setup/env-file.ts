import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Minimal dotenv parser: KEY=VALUE, `#` comments, optional `export`, optional quotes. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let value = (m[2] as string).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[m[1] as string] = value;
  }
  return out;
}

export interface PipedreamEnv {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
  /** Where the values came from, for the terminal message. Never the values themselves. */
  source: string;
}

const CANDIDATES = ["env.local", ".env.local", ".env"];

/** Real environment variables win over the file. */
export function loadPipedreamEnv(opts: {
  envFile?: string;
  searchDir: string;
  processEnv?: Record<string, string | undefined>;
}): PipedreamEnv {
  const proc = opts.processEnv ?? process.env;
  const file = opts.envFile ?? CANDIDATES.map((n) => join(opts.searchDir, n)).find((p) => existsSync(p));
  if (opts.envFile && !existsSync(opts.envFile)) throw new Error(`Env file not found: ${opts.envFile}`);
  const fromFile = file ? parseEnvFile(readFileSync(file, "utf8")) : {};
  const get = (k: string): string | undefined => proc[k] || fromFile[k] || undefined;

  const clientId = get("PIPEDREAM_CLIENT_ID");
  const clientSecret = get("PIPEDREAM_CLIENT_SECRET");
  const projectId = get("PIPEDREAM_PROJECT_ID");
  const missing = [
    ["PIPEDREAM_CLIENT_ID", clientId],
    ["PIPEDREAM_CLIENT_SECRET", clientSecret],
    ["PIPEDREAM_PROJECT_ID", projectId],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    const where = file ?? `${opts.searchDir}/env.local (not found)`;
    throw new Error(`Missing ${missing.join(", ")}. Add them to ${where} or export them in your shell.`);
  }
  const environment = get("PIPEDREAM_PROJECT_ENVIRONMENT") ?? "production";
  if (environment !== "production" && environment !== "development") {
    throw new Error(`PIPEDREAM_PROJECT_ENVIRONMENT must be "production" or "development" (got "${environment}")`);
  }
  return {
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    projectId: projectId as string,
    environment,
    source: file ?? "environment variables",
  };
}

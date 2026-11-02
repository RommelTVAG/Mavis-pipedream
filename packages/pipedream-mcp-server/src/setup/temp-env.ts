import { chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { parseEnvFile } from "./env-file.js";
import type { VaultPayload } from "./vault-source.js";

const START = "# >>> MAVIS TEMPORARY: removed when setup finishes";
const END = "# <<< MAVIS TEMPORARY";
const BLOCK = new RegExp(`\\n?${START.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s\\S]*?${END.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n?`, "g");

export interface TempEnv {
  path: string;
  /** Removes only the block this setup wrote; deletes the file if nothing else is in it. Safe to call twice. */
  cleanup(): void;
}

function stripBlock(text: string): string {
  return text.replace(BLOCK, "\n").replace(/^\n+/, "");
}

export function hasPipedreamCredentials(text: string): boolean {
  const env = parseEnvFile(text);
  return Boolean(env.PIPEDREAM_CLIENT_ID || env.PIPEDREAM_CLIENT_SECRET);
}

/** Removes a block left behind by an earlier run that was killed before it could clean up. */
export function removeStaleBlock(path: string): boolean {
  if (!existsSync(path)) return false;
  const text = readFileSync(path, "utf8");
  if (!text.includes(START)) return false;
  finishCleanup(path, stripBlock(text));
  return true;
}

function finishCleanup(path: string, remaining: string): void {
  if (remaining.trim() === "") unlinkSync(path);
  else writeFileSync(path, remaining.endsWith("\n") ? remaining : remaining + "\n");
}

/**
 * Writes the credentials into env.local for the duration of setup. Refuses to touch a file that
 * already holds Pipedream credentials (that is someone's own file, not ours to overwrite or delete).
 */
export function writeTempEnv(path: string, p: VaultPayload): TempEnv {
  removeStaleBlock(path);
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (hasPipedreamCredentials(existing)) {
    throw new Error(`${path} already contains Pipedream credentials. Remove them first so setup does not overwrite or delete your file.`);
  }
  const block = [
    START,
    `PIPEDREAM_CLIENT_ID=${p.clientId}`,
    `PIPEDREAM_CLIENT_SECRET=${p.clientSecret}`,
    `PIPEDREAM_PROJECT_ID=${p.projectId}`,
    `PIPEDREAM_PROJECT_ENVIRONMENT=${p.environment}`,
    END,
    "",
  ].join("\n");
  const prefix = existing === "" || existing.endsWith("\n") ? existing : existing + "\n";
  writeFileSync(path, prefix + block, { mode: 0o600 });
  chmodSync(path, 0o600);

  return {
    path,
    cleanup() {
      if (!existsSync(path)) return;
      const text = readFileSync(path, "utf8");
      if (text.includes(START)) finishCleanup(path, stripBlock(text));
    },
  };
}

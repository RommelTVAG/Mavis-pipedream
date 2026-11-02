import { spawnSync } from "node:child_process";

export interface RegisterResult {
  name: string;
  ok: boolean;
  /** Exact command to run by hand when automatic registration was not possible. */
  manualCommand: string;
}

export function serverName(slug: string): string {
  return `pipedream-${slug}`;
}

/** Argument vector (no shell) for `claude mcp add`. Slugs are [a-z0-9-] so nothing here needs quoting. */
export function addArgs(slug: string, entryPath: string, serverArgs: string[] = ["--client", slug]): string[] {
  return ["mcp", "add", "--scope", "user", serverName(slug), "--", "node", entryPath, ...serverArgs];
}

export function registerMcpServer(
  slug: string,
  entryPath: string,
  enabled: boolean,
  serverArgs?: string[],
): RegisterResult {
  const args = addArgs(slug, entryPath, serverArgs);
  const manualCommand = `claude ${args.map((a) => (/[^\w@%+=:,./-]/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
  if (!enabled) return { name: serverName(slug), ok: false, manualCommand };

  // Replace any earlier registration so re-running setup is idempotent.
  spawnSync("claude", ["mcp", "remove", "--scope", "user", serverName(slug)], { stdio: "ignore" });
  const res = spawnSync("claude", args, { stdio: "ignore" });
  return { name: serverName(slug), ok: res.status === 0, manualCommand };
}

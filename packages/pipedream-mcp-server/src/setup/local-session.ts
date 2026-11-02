import { writeLocalConfig, type LocalConfig } from "../credentials.js";
import type { PipedreamEnv } from "./env-file.js";
import { slugify, uniqueSlug } from "./merge.js";
import type { DiscoveredClient } from "./pipedream-api.js";
import { registerMcpServer, type RegisterResult } from "./register.js";
import { UserError } from "./session.js";

export interface LocalClientView extends DiscoveredClient {
  installed: boolean;
}

export interface LocalState {
  stage: "select" | "done";
  projectId: string;
  environment: string;
  clients: LocalClientView[];
  results?: RegisterResult[];
}

export interface LocalSessionOptions {
  env: PipedreamEnv;
  clients: DiscoveredClient[];
  existing: LocalConfig | null;
  entryPath: string;
  registerWithClaude: boolean;
  /** Overridable for tests. */
  save?: (c: LocalConfig) => void;
  register?: typeof registerMcpServer;
}

/**
 * Development install: pick clients (Pipedream external user IDs), save the Pipedream credentials on
 * this machine, and register one MCP server per client that talks to Pipedream directly.
 */
export class LocalSession {
  private stage: LocalState["stage"] = "select";
  private results?: RegisterResult[];

  constructor(private opts: LocalSessionOptions) {}

  get done(): boolean {
    return this.stage === "done";
  }

  async state(): Promise<LocalState> {
    const installed = new Set(this.opts.existing?.clients.map((c) => c.id));
    return {
      stage: this.stage,
      projectId: this.opts.env.projectId,
      environment: this.opts.env.environment,
      clients: this.opts.clients.map((c) => ({ ...c, installed: installed.has(c.id) })),
      results: this.results,
    };
  }

  /**
   * Short and readable (it becomes part of every tool name in Claude Code, which has a length limit):
   * the account name before the "@", at most 20 characters. On a clash, the first characters of the id
   * keep it recognisable; numbering is the last resort.
   */
  private slugFor(id: string, taken: Set<string>): string {
    const label = this.opts.clients.find((c) => c.id === id)?.label ?? id;
    const base = slugify(label.split("@")[0] ?? label, 20);
    if (!taken.has(base)) return base;
    const withId = slugify(`${base.slice(0, 15)}-${id.replace(/[^a-z0-9]/gi, "").slice(0, 4)}`, 20);
    return taken.has(withId) ? uniqueSlug(withId, taken) : withId;
  }

  async install(ids: string[]): Promise<LocalState> {
    if (this.stage !== "select") throw new UserError("Already installed in this session.");
    const unique = [...new Set(ids)];
    if (unique.length === 0) throw new UserError("Pick at least one client.");
    const known = new Set(this.opts.clients.map((c) => c.id));
    if (unique.some((id) => !known.has(id))) throw new UserError("One of those clients is not in this Pipedream project.");

    const { env, existing } = this.opts;
    const clients = existing && existing.projectId === env.projectId ? existing.clients.map((c) => ({ ...c })) : [];
    const taken = new Set(clients.map((c) => c.slug));
    for (const id of unique) {
      if (clients.some((c) => c.id === id)) continue;
      const slug = this.slugFor(id, taken);
      taken.add(slug);
      clients.push({ id, slug });
    }

    const save = this.opts.save ?? writeLocalConfig;
    save({
      version: 1,
      clientId: env.clientId,
      clientSecret: env.clientSecret,
      projectId: env.projectId,
      environment: env.environment,
      clients,
    });

    const register = this.opts.register ?? registerMcpServer;
    this.results = unique.map((id) => {
      const c = clients.find((x) => x.id === id)!;
      // The secret is read from local.json at runtime, so it never appears in the Claude Code config.
      return register(c.slug, this.opts.entryPath, this.opts.registerWithClaude, ["--user", id]);
    });
    this.stage = "done";
    return this.state();
  }
}

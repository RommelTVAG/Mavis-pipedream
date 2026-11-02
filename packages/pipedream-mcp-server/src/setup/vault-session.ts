import { AuthManager } from "../auth.js";
import type { LocalConfig } from "../credentials.js";
import { loadPipedreamEnv } from "./env-file.js";
import { LocalSession, type LocalClientView, type LocalState } from "./local-session.js";
import { listClients } from "./pipedream-api.js";
import type { registerMcpServer, RegisterResult } from "./register.js";
import type { VaultPayload } from "./vault-source.js";
import { UserError } from "./session.js";
import { writeTempEnv, type TempEnv } from "./temp-env.js";

export type VaultStage = "key" | "loading" | "select" | "done";

export interface VaultState {
  stage: VaultStage;
  /** Set on the key page after a failed attempt or a failed client load. */
  error?: string;
  /** Accounts read so far while loading. */
  progress: number;
  projectId?: string;
  environment?: string;
  clients: LocalClientView[];
  results?: RegisterResult[];
  /** True on the final page until the temporary credentials have been removed from env.local. */
  needsCleanup: boolean;
  cleaned: boolean;
}

export interface VaultSessionOptions {
  /** Asks the vault server for the credentials. Throws UserError with a safe message on failure. */
  fetchCredentials: (key: string) => Promise<VaultPayload>;
  /** Where the temporary env.local is written. */
  envPath: string;
  existing: LocalConfig | null;
  entryPath: string;
  registerWithClaude: boolean;
  maxAttempts?: number;
  /** After install, remove the temporary credentials by themselves if the final page never does. */
  fallbackCleanupMs?: number;
  /** Overridable for tests. */
  list?: typeof listClients;
  save?: (c: LocalConfig) => void;
  register?: typeof registerMcpServer;
}

/**
 * Key page → fetch the credentials from the vault → temporary env.local → list clients → install → the final
 * page removes the temporary credentials. The decrypted secret lives only in this process, the
 * temporary env.local, and (after install) local.json, which the installed MCP reads.
 */
export class VaultSession {
  private stage: VaultStage = "key";
  private error?: string;
  private progress = 0;
  private attempts = 0;
  private local?: LocalSession;
  private temp?: TempEnv;
  private cleaned = false;
  private fallbackTimer?: NodeJS.Timeout;
  private resolveFallback!: () => void;
  /** Resolves if the fallback cleanup fires, so the CLI can still exit when the tab was closed early. */
  readonly fallbackDone = new Promise<void>((r) => (this.resolveFallback = r));

  constructor(private opts: VaultSessionOptions) {}

  get done(): boolean {
    return this.stage === "done" && this.cleaned;
  }

  async state(): Promise<VaultState> {
    const base = { error: this.error, progress: this.progress, cleaned: this.cleaned, needsCleanup: this.stage === "done" && !this.cleaned };
    if (this.local && (this.stage === "select" || this.stage === "done")) {
      const l: LocalState = await this.local.state();
      return { ...base, stage: this.stage, projectId: l.projectId, environment: l.environment, clients: l.clients, results: l.results };
    }
    return { ...base, stage: this.stage, clients: [] };
  }

  /** Exchanges the key for the credentials, writes the temporary env.local and starts loading clients in the background. */
  async unlock(key: string): Promise<void> {
    if (this.stage !== "key") throw new UserError("Already unlocked.");
    const max = this.opts.maxAttempts ?? 5;
    if (this.attempts >= max) throw new UserError("Too many attempts. Close this tab and run setup again.");
    this.attempts += 1;

    const payload = await this.opts.fetchCredentials(key);

    try {
      this.temp = writeTempEnv(this.opts.envPath, payload);
    } catch (err) {
      throw new UserError(err instanceof Error ? err.message : String(err));
    }
    this.error = undefined;
    this.progress = 0;
    this.stage = "loading";
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      // The credentials are read back from the temporary env.local, ignoring the shell environment.
      const env = loadPipedreamEnv({ envFile: this.opts.envPath, searchDir: ".", processEnv: {} });
      const list = this.opts.list ?? listClients;
      const clients = await list(new AuthManager(env.clientId, env.clientSecret), env.projectId, env.environment, fetch, (n) => {
        this.progress = n;
      });
      this.local = new LocalSession({
        env,
        clients,
        existing: this.opts.existing,
        entryPath: this.opts.entryPath,
        registerWithClaude: this.opts.registerWithClaude,
        save: this.opts.save,
        register: this.opts.register,
      });
      this.stage = "select";
    } catch (err) {
      this.dispose();
      this.error = `Could not load clients from Pipedream: ${err instanceof Error ? err.message : String(err)}`;
      this.stage = "key";
    }
  }

  async install(ids: string[]): Promise<VaultState> {
    if (this.stage !== "select" || !this.local) throw new UserError("Unlock first.");
    await this.local.install(ids);
    this.stage = "done";
    const ms = this.opts.fallbackCleanupMs ?? 60_000;
    this.fallbackTimer = setTimeout(() => {
      this.dispose();
      this.resolveFallback();
    }, ms);
    this.fallbackTimer.unref();
    return this.state();
  }

  /** Called by the final page. Removes the temporary credentials from env.local. */
  async cleanup(): Promise<VaultState> {
    if (this.stage !== "done") throw new UserError("Install first.");
    this.dispose();
    return this.state();
  }

  /** Synchronous and idempotent: safe from exit and signal handlers. */
  dispose(): void {
    this.temp?.cleanup();
    if (this.stage === "done") {
      this.cleaned = true;
      if (this.fallbackTimer) clearTimeout(this.fallbackTimer);
    }
  }
}

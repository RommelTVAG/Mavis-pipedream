import { writeCredentials, type Credentials } from "../credentials.js";
import type { AllowedClient, BrokerClient, ConnectedApp } from "./broker-client.js";
import { mergeCredentials, type NewClient } from "./merge.js";
import { registerMcpServer, type RegisterResult } from "./register.js";

export const LOCK_PHRASE = "LOCK";
const APP_SLUG = /^[a-z0-9_]{1,64}$/;

export type Stage = "select" | "connect" | "done";

export interface SessionClient {
  id: string;
  name: string;
  slug?: string;
  apps: ConnectedApp[];
}

export interface PublicState {
  stage: Stage;
  mode: "enroll" | "manage";
  operator?: string;
  allowed: AllowedClient[];
  selected: SessionClient[];
  results?: RegisterResult[];
  lockPhrase: string;
}

export class UserError extends Error {}

export interface SessionOptions {
  broker: BrokerClient;
  brokerUrl: string;
  /** Setup-code secret. Present in enroll mode only. */
  secret?: string;
  existing: Credentials | null;
  entryPath: string;
  registerWithClaude: boolean;
  /** Overridable for tests. */
  save?: (c: Credentials) => void;
  register?: typeof registerMcpServer;
}

interface Picked extends NewClient {}

/**
 * All setup state lives here, in the CLI process. The browser page is a thin view: it can only
 * ask for transitions, and the broker re-validates every one of them.
 */
export class SetupSession {
  private stage: Stage;
  private allowed: AllowedClient[] = [];
  private operator?: string;
  private picked: Picked[] = [];
  private results?: RegisterResult[];

  private constructor(private opts: SessionOptions) {
    this.stage = opts.secret ? "select" : "connect";
  }

  /** Enroll mode (with a setup code) or manage mode (sealed install on this machine). */
  static async start(opts: SessionOptions): Promise<SetupSession> {
    const s = new SetupSession(opts);
    if (opts.secret) {
      const info = await opts.broker.enroll(opts.secret);
      s.allowed = info.clients;
      s.operator = info.label;
    } else {
      if (!opts.existing?.sealed) throw new UserError("Nothing to manage yet. Run setup with a setup code first.");
      s.picked = opts.existing.clients.map((c) => ({ id: c.id, name: c.name, token: c.token }));
    }
    return s;
  }

  get done(): boolean {
    return this.stage === "done";
  }

  private slugFor(id: string): string | undefined {
    return this.opts.existing?.clients.find((c) => c.id === id)?.slug;
  }

  async state(): Promise<PublicState> {
    const selected: SessionClient[] = [];
    for (const p of this.picked) {
      let apps: ConnectedApp[] = [];
      if (this.stage === "connect") {
        try {
          apps = await this.opts.broker.accounts(p.token);
        } catch {
          // A transient lookup failure shouldn't block the page; the list just shows empty.
        }
      }
      selected.push({ id: p.id, name: p.name, slug: this.slugFor(p.id), apps });
    }
    return {
      stage: this.stage,
      mode: this.opts.secret ? "enroll" : "manage",
      operator: this.operator,
      allowed: this.allowed,
      selected,
      results: this.results,
      lockPhrase: LOCK_PHRASE,
    };
  }

  async select(ids: string[]): Promise<void> {
    if (this.stage !== "select") throw new UserError("Selection is already made for this session.");
    if (ids.length === 0) throw new UserError("Pick at least one client.");
    const issued = await this.opts.broker.select(this.opts.secret as string, ids);
    this.picked = issued.map((c) => ({ id: c.id, name: c.name, token: c.token }));
    this.stage = "connect";
  }

  async connect(clientId: string, app: string, redirectUri: string): Promise<string> {
    if (this.stage !== "connect") throw new UserError("Choose clients first.");
    const picked = this.picked.find((p) => p.id === clientId);
    if (!picked) throw new UserError("That client is not part of this install.");
    const slug = app.trim().toLowerCase();
    if (!APP_SLUG.test(slug)) throw new UserError("App name should look like slack, gmail or google_sheets.");
    return this.opts.broker.connectToken(picked.token, { redirectUri, app: slug });
  }

  async finish(confirm: string): Promise<void> {
    if (this.stage !== "connect") throw new UserError("Nothing to finish yet.");
    const save = this.opts.save ?? writeCredentials;
    const register = this.opts.register ?? registerMcpServer;

    if (this.opts.secret) {
      if (confirm !== LOCK_PHRASE) throw new UserError(`Type ${LOCK_PHRASE} to confirm.`);
      // Persist tokens before sealing: once sealed the broker will not issue them again, so a
      // failed write after finalize would lock the operator out of their own install.
      save(mergeCredentials(this.opts.existing, this.opts.brokerUrl, this.picked, false));
      await this.opts.broker.finalize(this.opts.secret);
      const merged = mergeCredentials(this.opts.existing, this.opts.brokerUrl, this.picked, true);
      save(merged);
      this.results = merged.clients
        .filter((c) => this.picked.some((p) => p.id === c.id))
        .map((c) => register(c.slug, this.opts.entryPath, this.opts.registerWithClaude));
    }
    this.stage = "done";
  }
}

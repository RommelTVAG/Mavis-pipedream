import pino from "pino";
import { parseEnv, type Env } from "../src/env.js";
import { MemoryStore } from "../src/store.js";
import { PipedreamClient } from "../src/pipedream.js";
import { dispatch, type Deps } from "../src/http.js";
import { routes, type RouteName } from "../src/routes.js";
import { createCode, decodeSetupCode, type ClientEntry } from "../src/codes.js";

export const ENV: Env = parseEnv({
  PIPEDREAM_CLIENT_ID: "cid_test",
  PIPEDREAM_CLIENT_SECRET: "super-secret-value",
  PIPEDREAM_PROJECT_ID: "proj_test",
  PIPEDREAM_PROJECT_ENVIRONMENT: "production",
  PIPEDREAM_API_BASE: "https://pd.test/v1",
  BROKER_SIGNING_KEY: "k".repeat(48),
  BROKER_PUBLIC_URL: "https://broker.test",
});

export interface Call {
  url: string;
  method: string;
  body: unknown;
}

export interface Harness {
  deps: Deps;
  store: MemoryStore;
  calls: Call[];
  clock: { now: number };
  call(name: RouteName, opts?: { token?: string; body?: unknown; method?: string; ip?: string }): Promise<{ status: number; body: any }>;
  issue(clients?: ClientEntry[]): Promise<{ code: string; secret: string; id: string }>;
}

export function harness(opts: { connectLinkUrl?: string } = {}): Harness {
  const calls: Call[] = [];
  const clock = { now: Date.UTC(2026, 0, 1) };
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method: init?.method ?? "GET", body });
    if (url.endsWith("/oauth/token")) {
      return Response.json({ access_token: "pd_access", expires_in: 3600 });
    }
    if (url.endsWith("/tokens")) {
      return Response.json({
        token: "ctok",
        expires_at: "2026-01-01T01:00:00Z",
        connect_link_url: opts.connectLinkUrl ?? "https://pipedream.com/_static/connect.html?token=ctok&connectLink=true",
      });
    }
    if (url.includes("/accounts")) {
      return Response.json({
        data: [
          { id: "apn_1", healthy: true, dead: false, app: { name_slug: "slack", name: "Slack" } },
          { id: "apn_2", healthy: false, dead: true, app: { name_slug: "gmail", name: "Gmail" } },
        ],
      });
    }
    return new Response("not found", { status: 404 });
  };

  const store = new MemoryStore();
  const deps: Deps = {
    env: ENV,
    store,
    pipedream: new PipedreamClient(ENV, fakeFetch),
    log: pino({ level: "silent" }),
    now: () => clock.now,
  };

  return {
    deps,
    store,
    calls,
    clock,
    async call(name, o = {}) {
      const headers: Record<string, string> = { "x-forwarded-for": o.ip ?? "1.2.3.4" };
      if (o.token) headers.authorization = `Bearer ${o.token}`;
      const route = routes[name];
      const req = new Request(`https://broker.test/api/${name}`, {
        method: o.method ?? route.method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
      });
      const res = await dispatch(route, req, deps);
      return { status: res.status, body: await res.json() };
    },
    async issue(clients = [{ id: "cust_a", name: "Acme" }, { id: "cust_b", name: "Beta" }, { id: "cust_c", name: "Gamma" }]) {
      const { code, record } = await createCode(store, { label: "op", clients, brokerUrl: "https://broker.test" });
      const decoded = decodeSetupCode(code);
      if (!decoded) throw new Error("bad code");
      return { code, secret: decoded.secret, id: record.id };
    },
  };
}

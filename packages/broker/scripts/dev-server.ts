/**
 * Local broker for development and end-to-end tests. In-memory store, and a mock Pipedream API
 * unless real PIPEDREAM_* credentials are supplied. Never use in production.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger } from "../src/logger.js";
import { parseEnv } from "../src/env.js";
import { PipedreamClient } from "../src/pipedream.js";
import { MemoryStore } from "../src/store.js";
import { createCode } from "../src/codes.js";
import { dispatch, type Deps } from "../src/http.js";
import { routes, routePaths } from "../src/routes.js";

const PORT = Number(process.env.PORT ?? 8787);
const MOCK_PORT = PORT + 1;
const accounts = new Map<string, Array<{ id: string; app: { name_slug: string; name: string } }>>();

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

function startMockPipedream(): void {
  createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${MOCK_PORT}`);
    const body = await readBody(req);
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/v1/oauth/token") return send(200, { access_token: "mock_access", expires_in: 3600 });
    if (url.pathname.endsWith("/tokens")) {
      return send(200, {
        token: "ctok",
        expires_at: new Date(Date.now() + 3600_000).toISOString(),
        connect_link_url: `https://pipedream.com/_static/connect.html?token=mock&connectLink=true&uid=${JSON.parse(body).external_user_id}`,
      });
    }
    if (url.pathname.endsWith("/accounts")) {
      const uid = url.searchParams.get("external_user_id") ?? "";
      return send(200, { data: (accounts.get(uid) ?? []).map((a) => ({ ...a, healthy: true, dead: false })) });
    }
    if (url.pathname === "/__mock/connect") {
      const { external_user_id, app } = JSON.parse(body) as { external_user_id: string; app: string };
      const list = accounts.get(external_user_id) ?? [];
      list.push({ id: `apn_${list.length + 1}`, app: { name_slug: app, name: app } });
      accounts.set(external_user_id, list);
      return send(200, { ok: true });
    }
    send(404, { error: "not found" });
  }).listen(MOCK_PORT, "127.0.0.1");
}

async function main(): Promise<void> {
  const mock = !process.env.PIPEDREAM_CLIENT_SECRET;
  if (mock) startMockPipedream();

  const env = parseEnv({
    PIPEDREAM_CLIENT_ID: "mock",
    PIPEDREAM_CLIENT_SECRET: "mock",
    PIPEDREAM_PROJECT_ID: "proj_mock",
    BROKER_SIGNING_KEY: "dev-signing-key-dev-signing-key-dev-signing-key",
    BROKER_PUBLIC_URL: `http://127.0.0.1:${PORT}`,
    PIPEDREAM_API_BASE: mock ? `http://127.0.0.1:${MOCK_PORT}/v1` : undefined,
    ...(mock ? {} : process.env),
  });
  const store = new MemoryStore();
  const deps: Deps = { env, store, pipedream: new PipedreamClient(env), log: createLogger(process.env.LOG_LEVEL ?? "warn"), now: Date.now };
  const byPath = new Map(Object.entries(routePaths).map(([name, path]) => [path, name as keyof typeof routes]));

  createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    const name = byPath.get(url.pathname);
    if (url.pathname === "/__mock/connect" && mock) {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/__mock/connect`, { method: "POST", body: await readBody(req) });
      res.writeHead(r.status).end(await r.text());
      return;
    }
    if (!name) {
      res.writeHead(404).end();
      return;
    }
    const body = req.method === "GET" || req.method === "HEAD" ? undefined : await readBody(req);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const out = await dispatch(routes[name], new Request(url, { method: req.method, headers, body }), deps);
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(await out.text());
  }).listen(PORT, "127.0.0.1", async () => {
    const { code } = await createCode(store, {
      label: "dev operator",
      brokerUrl: env.BROKER_PUBLIC_URL,
      clients: [
        { id: "cust_acme", name: "Acme Corp" },
        { id: "cust_beta", name: "Beta LLC" },
        { id: "cust_gamma", name: "Gamma Inc" },
      ],
    });
    process.stdout.write(`broker listening on ${env.BROKER_PUBLIC_URL}${mock ? ` (mock pipedream on :${MOCK_PORT})` : ""}\nSETUP_CODE=${code}\n`);
  });
}

void main();

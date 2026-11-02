import { test } from "node:test";
import assert from "node:assert/strict";
import { request } from "node:http";
import { startLocalServer, type LocalServer } from "../src/setup/local-server.js";
import { SetupSession } from "../src/setup/session.js";
import { brokerController } from "../src/setup/controllers.js";
import { asClient, FakeBroker } from "./fakes.js";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function http(port: number, path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const req = request(
      { host: "127.0.0.1", port, path, method: opts.method ?? "GET", headers: { ...(payload ? { "content-type": "application/json" } : {}), ...opts.headers } },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function boot() {
  const broker = new FakeBroker();
  const session = await SetupSession.start({
    broker: asClient(broker),
    brokerUrl: "https://broker.test",
    secret: "sekret",
    existing: null,
    entryPath: "/x/index.js",
    registerWithClaude: false,
    save: () => {},
    register: (slug) => ({ name: `pipedream-${slug}`, ok: true, manualCommand: "" }),
  });
  const server: LocalServer = await startLocalServer(brokerController(session));
  const nonce = new URL(server.url).searchParams.get("s")!;
  const enter = await http(server.port, `/?s=${nonce}`);
  const cookie = String(enter.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;
  const origin = `http://127.0.0.1:${server.port}`;
  return { broker, session, server, nonce, enter, cookie, origin };
}

test("entry nonce is single-use and exchanged for an HttpOnly cookie", async () => {
  const { server, nonce, enter } = await boot();
  try {
    assert.equal(enter.status, 302);
    assert.match(String(enter.headers["set-cookie"]), /mvs=.+; HttpOnly; SameSite=Lax/);
    assert.equal((await http(server.port, `/?s=${nonce}`)).status, 403);
    assert.equal((await http(server.port, `/?s=wrong`)).status, 403);
  } finally {
    server.close();
  }
});

test("no cookie: page and API are refused; wrong cookie too", async () => {
  const { server } = await boot();
  try {
    assert.equal((await http(server.port, "/")).status, 403);
    assert.equal((await http(server.port, "/api/state")).status, 404);
    assert.equal((await http(server.port, "/api/state", { headers: { cookie: "mvs=nope" } })).status, 404);
  } finally {
    server.close();
  }
});

test("Host header must match the loopback address (DNS rebinding)", async () => {
  const { server, cookie } = await boot();
  try {
    const r = await http(server.port, "/api/state", { headers: { cookie, host: "evil.example" } });
    assert.equal(r.status, 403);
  } finally {
    server.close();
  }
});

test("page is served with a strict CSP and element ids", async () => {
  const { server, cookie } = await boot();
  try {
    const r = await http(server.port, "/", { headers: { cookie } });
    assert.equal(r.status, 200);
    const csp = String(r.headers["content-security-policy"]);
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /script-src 'nonce-/);
    assert.match(r.body, /id="mvs-root"/);
    assert.ok(!/innerHTML/.test(r.body));
  } finally {
    server.close();
  }
});

test("POSTs need a matching Origin even with a valid cookie", async () => {
  const { server, cookie, origin } = await boot();
  try {
    const body = { clientIds: ["cust_a"] };
    assert.equal((await http(server.port, "/api/select", { method: "POST", headers: { cookie }, body })).status, 403);
    assert.equal((await http(server.port, "/api/select", { method: "POST", headers: { cookie, origin: "https://evil.example" }, body })).status, 403);
    assert.equal((await http(server.port, "/api/select", { method: "POST", headers: { cookie, origin }, body })).status, 200);
  } finally {
    server.close();
  }
});

test("full flow over HTTP: select, connect (loopback redirect), lock, finished resolves", async () => {
  const { server, cookie, origin, broker } = await boot();
  try {
    const h = { cookie, origin };
    const st0 = JSON.parse((await http(server.port, "/api/state", { headers: h })).body);
    assert.equal(st0.stage, "select");
    assert.equal(st0.allowed.length, 3);

    assert.equal((await http(server.port, "/api/select", { method: "POST", headers: h, body: { clientIds: ["cust_a", "cust_b"] } })).status, 200);
    const conn = await http(server.port, "/api/connect", { method: "POST", headers: h, body: { clientId: "cust_b", app: "slack" } });
    assert.equal(conn.status, 200);
    assert.match(JSON.parse(conn.body).url, /^https:\/\/pipedream\.com\//);

    const bad = await http(server.port, "/api/finish", { method: "POST", headers: h, body: { confirm: "nope" } });
    assert.equal(bad.status, 400);
    assert.equal(broker.sealed, false);

    const fin = await http(server.port, "/api/finish", { method: "POST", headers: h, body: { confirm: "LOCK" } });
    assert.equal(fin.status, 200);
    assert.equal(JSON.parse(fin.body).stage, "done");
    await server.finished;
    assert.equal(broker.sealed, true);
  } finally {
    server.close();
  }
});

test("callback page needs no cookie and sends the browser back to setup", async () => {
  const { server } = await boot();
  try {
    const r = await http(server.port, "/callback");
    assert.equal(r.status, 200);
    assert.match(r.body, /url=\//);
  } finally {
    server.close();
  }
});

test("oversized and malformed bodies are rejected without crashing the server", async () => {
  const { server, cookie, origin } = await boot();
  try {
    const h = { cookie, origin };
    const big = await http(server.port, "/api/select", { method: "POST", headers: h, body: { clientIds: ["x".repeat(20_000)] } }).catch(() => ({ status: 0 }));
    assert.ok([0, 400].includes(big.status));
    assert.equal((await http(server.port, "/api/state", { headers: h })).status, 200);
  } finally {
    server.close();
  }
});

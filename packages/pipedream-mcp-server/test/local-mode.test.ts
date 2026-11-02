import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { parseEnvFile, loadPipedreamEnv } from "../src/setup/env-file.js";
import { listClients } from "../src/setup/pipedream-api.js";
import { LocalSession } from "../src/setup/local-session.js";
import { localController } from "../src/setup/controllers.js";
import { startLocalServer } from "../src/setup/local-server.js";
import { UserError } from "../src/setup/session.js";
import type { LocalConfig } from "../src/credentials.js";
import type { RegisterResult } from "../src/setup/register.js";

const ENV = { clientId: "cid", clientSecret: "SECRET_VALUE", projectId: "proj_x", environment: "production", source: "test" };

test("parseEnvFile handles comments, export, quotes, blanks", () => {
  const out = parseEnvFile('#PIPEDREAM\n\nA=1\nexport B="two words"\nC=\'x\'\n  D = spaced \nnot a line\n');
  assert.deepEqual(out, { A: "1", B: "two words", C: "x", D: "spaced" });
});

test("loadPipedreamEnv: file values, process env wins, clear errors", () => {
  const dir = mkdtempSync(join(tmpdir(), "mavis-env-"));
  try {
    writeFileSync(join(dir, "env.local"), "PIPEDREAM_CLIENT_ID=fid\nPIPEDREAM_CLIENT_SECRET=fsecret\n");
    assert.throws(() => loadPipedreamEnv({ searchDir: dir, processEnv: {} }), /Missing PIPEDREAM_PROJECT_ID/);
    const e = loadPipedreamEnv({ searchDir: dir, processEnv: { PIPEDREAM_PROJECT_ID: "proj_1", PIPEDREAM_CLIENT_ID: "override" } });
    assert.equal(e.clientId, "override");
    assert.equal(e.clientSecret, "fsecret");
    assert.equal(e.projectId, "proj_1");
    assert.equal(e.environment, "production");
    assert.throws(() => loadPipedreamEnv({ searchDir: dir, processEnv: { PIPEDREAM_PROJECT_ID: "p", PIPEDREAM_PROJECT_ENVIRONMENT: "staging" } }), /production|development/);
    assert.throws(() => loadPipedreamEnv({ searchDir: dir, envFile: join(dir, "nope"), processEnv: {} }), /not found/);
    assert.throws(() => loadPipedreamEnv({ searchDir: join(dir, "empty"), processEnv: {} }), /Missing PIPEDREAM_CLIENT_ID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function acct(ext: string, app: string, ok = true, name: string | null = null, updated?: string) {
  return { external_id: ext, name, updated_at: updated, healthy: ok, dead: false, app: { name_slug: app } };
}

test("listClients paginates, groups by external user, separates unhealthy", async () => {
  const pages: Record<string, unknown> = {
    first: { data: [...Array.from({ length: 99 }, () => acct("u1", "slack")), acct("u2", "gmail")], page_info: { end_cursor: "c1" } },
    c1: { data: [acct("u2", "github"), acct("u2", "gmail", false), acct("u3", "slack")], page_info: { end_cursor: "c2" } },
  };
  const seen: string[] = [];
  const f: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push(`${url.searchParams.get("after") ?? "first"}|${new Headers(init?.headers).get("x-pd-environment")}`);
    return Response.json(pages[url.searchParams.get("after") ?? "first"]);
  };
  const progress: number[] = [];
  const clients = await listClients({ getToken: async () => "t" }, "proj_x", "production", f, (n) => progress.push(n));
  assert.deepEqual(progress, [100, 103], "progress is reported after each page");
  assert.deepEqual(seen, ["first|production", "c1|production"]);
  assert.deepEqual(clients, [
    { id: "u1", label: "u1", names: [], apps: ["slack"], unhealthy: 0, accounts: 99, lastUpdated: null },
    { id: "u2", label: "u2", names: [], apps: ["github", "gmail"], unhealthy: 1, accounts: 3, lastUpdated: null },
    { id: "u3", label: "u3", names: [], apps: ["slack"], unhealthy: 0, accounts: 1, lastUpdated: null },
  ]);
});

test("listClients surfaces API failure without leaking the token", async () => {
  const f: typeof fetch = async () => new Response("no", { status: 401 });
  await assert.rejects(listClients({ getToken: async () => "SECRET_TOKEN" }, "p", "production", f), (e: Error) => /401/.test(e.message) && !e.message.includes("SECRET_TOKEN"));
});

function make(existing: LocalConfig | null = null) {
  const saved: LocalConfig[] = [];
  const registered: Array<{ slug: string; args?: string[] }> = [];
  const session = new LocalSession({
    env: ENV,
    clients: [
      { id: "acme@example.com", label: "acme@example.com", names: ["acme@example.com"], apps: ["gmail"], unhealthy: 0, accounts: 1, lastUpdated: null },
      { id: "Beta Corp", label: "Beta Corp", names: [], apps: [], unhealthy: 1, accounts: 1, lastUpdated: null },
      { id: "cust-3", label: "cust-3", names: [], apps: ["slack", "github"], unhealthy: 0, accounts: 2, lastUpdated: null },
    ],
    existing,
    entryPath: "/x/dist/index.js",
    registerWithClaude: false,
    save: (c) => void saved.push(JSON.parse(JSON.stringify(c))),
    register: (slug, _e, _on, args): RegisterResult => {
      registered.push({ slug, args });
      return { name: `pipedream-${slug}`, ok: true, manualCommand: "" };
    },
  });
  return { session, saved, registered };
}

test("install saves credentials once and registers one server per client with --user", async () => {
  const { session, saved, registered } = make();
  assert.equal((await session.state()).stage, "select");
  const done = await session.install(["acme@example.com", "cust-3", "cust-3"]);
  assert.equal(done.stage, "done");
  assert.equal(session.done, true);

  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.clientSecret, "SECRET_VALUE");
  assert.deepEqual(saved[0]?.clients, [
    { id: "acme@example.com", slug: "acme" },
    { id: "cust-3", slug: "cust-3" },
  ]);
  assert.deepEqual(registered.map((r) => [r.slug, r.args]), [
    ["acme", ["--user", "acme@example.com"]],
    ["cust-3", ["--user", "cust-3"]],
  ]);
  // The secret must never travel via the Claude Code registration.
  assert.ok(!JSON.stringify(registered).includes("SECRET_VALUE"));
  await assert.rejects(session.install(["cust-3"]), UserError);
});

test("install guards: empty, unknown client", async () => {
  await assert.rejects(make().session.install([]), UserError);
  await assert.rejects(make().session.install(["someone-else"]), /not in this Pipedream project/);
});

test("install keeps slugs of already-installed clients and flags them", async () => {
  const existing: LocalConfig = { version: 1, clientId: "old", clientSecret: "old", projectId: "proj_x", environment: "production", clients: [{ id: "cust-3", slug: "my-custom" }] };
  const { session, saved, registered } = make(existing);
  assert.equal((await session.state()).clients.find((c) => c.id === "cust-3")?.installed, true);
  await session.install(["cust-3", "Beta Corp"]);
  assert.deepEqual(saved[0]?.clients.map((c) => c.slug), ["my-custom", "beta-corp"]);
  assert.equal(saved[0]?.clientId, "cid"); // credentials refreshed from the env file
  assert.deepEqual(registered.map((r) => r.slug), ["my-custom", "beta-corp"]);
});

test("existing clients from a different project are not carried over", async () => {
  const existing: LocalConfig = { version: 1, clientId: "old", clientSecret: "old", projectId: "proj_other", environment: "production", clients: [{ id: "legacy", slug: "legacy" }] };
  const { session, saved } = make(existing);
  await session.install(["cust-3"]);
  assert.deepEqual(saved[0]?.clients, [{ id: "cust-3", slug: "cust-3" }]);
});

test("local page over HTTP: list, install, finished resolves; same protections as the broker page", async () => {
  const { session } = make();
  const server = await startLocalServer(localController(session));
  const call = (path: string, o: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
      const req = request({ host: "127.0.0.1", port: server.port, path, method: o.method ?? "GET", headers: { ...(payload ? { "content-type": "application/json" } : {}), ...o.headers } }, (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b }));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  try {
    const nonce = new URL(server.url).searchParams.get("s")!;
    assert.equal((await call("/api/state")).status, 404);
    const enter = await call(`/?s=${nonce}`);
    const cookie = String((enter.headers["set-cookie"] as string[])[0]).split(";")[0]!;
    const origin = `http://127.0.0.1:${server.port}`;

    const page = await call("/", { headers: { cookie } });
    assert.match(page.body, /id="mvs-root"/);
    assert.match(String(page.headers["content-security-policy"]), /script-src 'nonce-/);

    const st = JSON.parse((await call("/api/state", { headers: { cookie } })).body);
    assert.equal(st.clients.length, 3);
    assert.equal(st.projectId, "proj_x");
    assert.ok(!JSON.stringify(st).includes("SECRET_VALUE"), "state sent to the browser must not contain the secret");

    assert.equal((await call("/api/install", { method: "POST", headers: { cookie }, body: { clientIds: ["cust-3"] } })).status, 403);
    assert.equal((await call("/api/install", { method: "POST", headers: { cookie, origin }, body: { clientIds: ["nobody"] } })).status, 400);
    const ok = await call("/api/install", { method: "POST", headers: { cookie, origin }, body: { clientIds: ["cust-3"] } });
    assert.equal(ok.status, 200);
    assert.equal(JSON.parse(ok.body).stage, "done");
    assert.ok(!ok.body.includes("SECRET_VALUE"));
    await server.finished;
    assert.equal((await call("/api/__proto__", { method: "POST", headers: { cookie, origin }, body: {} })).status, 404);
  } finally {
    server.close();
  }
});


test("listClients labels users by account name: email first, then most used; sorted by label", async () => {
  const body = {
    data: [
      acct("u1", "github", true, "octocat"),
      acct("u1", "github", true, "octocat"),
      acct("u1", "gmail", true, "zed@client.com"),
      acct("u1", "slack", true, "  "),
      acct("u2", "gmail", false, "amy@acme.io"),
      acct("u2", "gmail", true, "amy@acme.io"),
      acct("u2", "gmail", true, "other@acme.io"),
      acct("u3", "github", true, "only-a-username"),
      acct("u4", "slack", true, null),
    ],
    page_info: {},
  };
  const f: typeof fetch = async () => Response.json(body);
  const clients = await listClients({ getToken: async () => "t" }, "p", "production", f);

  assert.deepEqual(clients.map((c) => c.label), ["amy@acme.io", "only-a-username", "u4", "zed@client.com"]);
  const u1 = clients.find((c) => c.id === "u1")!;
  assert.equal(u1.label, "zed@client.com", "an email beats a more frequent username");
  assert.deepEqual(u1.names, ["zed@client.com", "octocat"]);
  const u2 = clients.find((c) => c.id === "u2")!;
  assert.deepEqual(u2.names, ["amy@acme.io", "other@acme.io"], "names are deduplicated and ranked by use");
  assert.equal(u2.unhealthy, 1, "unhealthy accounts still contribute their name");
  assert.equal(clients.find((c) => c.id === "u4")!.label, "u4", "no name falls back to the id");
});

function sessionWith(clients: Array<{ id: string; label: string }>) {
  const saved: LocalConfig[] = [];
  const session = new LocalSession({
    env: ENV,
    clients: clients.map((c) => ({ ...c, names: [c.label], apps: [], unhealthy: 0, accounts: 0, lastUpdated: null })),
    existing: null,
    entryPath: "/x/index.js",
    registerWithClaude: false,
    save: (c) => void saved.push(JSON.parse(JSON.stringify(c))),
    register: (slug): RegisterResult => ({ name: `pipedream-${slug}`, ok: true, manualCommand: "" }),
  });
  return { session, saved };
}

test("slugs are readable, at most 20 chars, and stay distinct when two clients share a name", async () => {
  const { session, saved } = sessionWith([
    { id: "5d1c0b7e-3f2a-4c8e-9a41-0b6e7d2f1a90", label: "jordan.avery.example.corp@example.com" },
    { id: "aaaa1111-0000-0000-0000-000000000000", label: "pat@one.com" },
    { id: "bbbb2222-0000-0000-0000-000000000000", label: "pat@two.com" },
    { id: "cccc3333-0000-0000-0000-000000000000", label: "pat@three.com" },
    { id: "dddd4444-0000-0000-0000-000000000000", label: "@@@" },
  ]);
  await session.install(["5d1c0b7e-3f2a-4c8e-9a41-0b6e7d2f1a90", "aaaa1111-0000-0000-0000-000000000000", "bbbb2222-0000-0000-0000-000000000000", "cccc3333-0000-0000-0000-000000000000", "dddd4444-0000-0000-0000-000000000000"]);
  const slugs = saved[0]!.clients.map((c) => c.slug);
  assert.equal(slugs[0], "jordan-avery-example");
  assert.equal(slugs[1], "pat");
  assert.equal(slugs[2], "pat-bbbb");
  assert.equal(slugs[3], "pat-cccc");
  assert.ok(slugs.every((s) => s.length <= 20 && /^[a-z0-9-]+$/.test(s) && !s.endsWith("-")), slugs.join(","));
  assert.equal(new Set(slugs).size, slugs.length);
});


test("listClients reports account count and most recent update per client", async () => {
  const body = {
    data: [
      acct("u1", "gmail", true, "a@x.com", "2026-01-05T10:00:00Z"),
      acct("u1", "slack", true, "a@x.com", "2026-03-09T08:30:00Z"),
      acct("u1", "github", true, "a@x.com", "garbage"),
      acct("u2", "gmail", true, "b@x.com"),
    ],
    page_info: {},
  };
  const clients = await listClients({ getToken: async () => "t" }, "p", "production", async () => Response.json(body));
  const u1 = clients.find((c) => c.id === "u1")!;
  assert.equal(u1.accounts, 3);
  assert.equal(u1.lastUpdated, "2026-03-09T08:30:00.000Z");
  assert.equal(clients.find((c) => c.id === "u2")!.lastUpdated, null);
});

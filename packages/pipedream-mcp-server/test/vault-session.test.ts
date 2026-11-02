import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VaultSession, type VaultSessionOptions } from "../src/setup/vault-session.js";
import { UserError } from "../src/setup/session.js";
import { vaultController } from "../src/setup/controllers.js";
import { startLocalServer } from "../src/setup/local-server.js";
import type { VaultPayload } from "../src/setup/vault-source.js";
import type { DiscoveredClient } from "../src/setup/pipedream-api.js";
import type { LocalConfig } from "../src/credentials.js";
import type { RegisterResult } from "../src/setup/register.js";

const GOOD_KEY = "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE";
const PAYLOAD: VaultPayload = { clientId: "cid-vault", clientSecret: "VAULT_SECRET_VALUE", projectId: "proj_vault", environment: "development" };
const CLIENTS: DiscoveredClient[] = [
  { id: "id-a", label: "alice@acme.com", names: ["alice@acme.com"], apps: ["gmail"], unhealthy: 0, accounts: 1, lastUpdated: null },
  { id: "id-b", label: "bob@beta.io", names: ["bob@beta.io"], apps: ["slack"], unhealthy: 0, accounts: 2, lastUpdated: null },
];

let dir: string;
let envPath: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mavis-vault-session-"));
  envPath = join(dir, "env.local");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function make(over: Partial<VaultSessionOptions> = {}) {
  const calls: Array<{ projectId: string; environment: string }> = [];
  const asked: string[] = [];
  const saved: LocalConfig[] = [];
  const registered: string[] = [];
  const opts: VaultSessionOptions = {
    fetchCredentials: async (key) => {
      asked.push(key);
      if (key !== GOOD_KEY) throw new UserError("That key didn't work. Check it and try again.");
      return PAYLOAD;
    },
    envPath,
    existing: null,
    entryPath: "/x/dist/index.js",
    registerWithClaude: false,
    fallbackCleanupMs: 60_000,
    list: async (_auth, projectId, environment, _f, onProgress) => {
      calls.push({ projectId, environment });
      onProgress?.(100);
      return CLIENTS;
    },
    save: (c) => void saved.push(JSON.parse(JSON.stringify(c))),
    register: (slug): RegisterResult => {
      registered.push(slug);
      return { name: `pipedream-${slug}`, ok: true, manualCommand: "" };
    },
    ...over,
  };
  return { session: new VaultSession(opts), calls, asked, saved, registered };
}

async function until(session: VaultSession, stage: string) {
  for (let i = 0; i < 200; i++) {
    const s = await session.state();
    if (s.stage === stage) return s;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`never reached ${stage}`);
}

test("a refused key writes nothing, and the page gives up after too many tries", async () => {
  const { session } = make({ maxAttempts: 3 });
  for (let i = 0; i < 3; i++) await assert.rejects(session.unlock("WRONG"), /didn't work/);
  assert.equal(existsSync(envPath), false);
  await assert.rejects(session.unlock(GOOD_KEY), /Too many attempts/);
  assert.equal((await session.state()).stage, "key");
});

test("right key: credentials from the vault go to a temp env.local and are used; page state never holds the secret", async () => {
  const { session, calls, asked } = make();
  await session.unlock(GOOD_KEY);
  assert.deepEqual(asked, [GOOD_KEY]);
  assert.match(readFileSync(envPath, "utf8"), /PIPEDREAM_CLIENT_SECRET=VAULT_SECRET_VALUE/);
  const s = await until(session, "select");
  assert.deepEqual(calls, [{ projectId: "proj_vault", environment: "development" }]);
  assert.equal(s.clients.length, 2);
  assert.equal(s.progress, 100);
  assert.ok(!JSON.stringify(s).includes("VAULT_SECRET_VALUE"));
  assert.ok(!JSON.stringify(s).includes("cid-vault"));
});

test("the shell environment cannot override the credentials the vault returned", async () => {
  process.env.PIPEDREAM_PROJECT_ID = "proj_from_shell";
  try {
    const { session, calls } = make();
    await session.unlock(GOOD_KEY);
    await until(session, "select");
    assert.equal(calls[0]?.projectId, "proj_vault");
  } finally {
    delete process.env.PIPEDREAM_PROJECT_ID;
  }
});

test("install saves credentials for the runtime, then the final page removes env.local", async () => {
  const { session, saved, registered } = make();
  await session.unlock(GOOD_KEY);
  await until(session, "select");
  await assert.rejects(session.cleanup(), UserError);

  const done = await session.install(["id-b"]);
  assert.equal(done.stage, "done");
  assert.equal(done.needsCleanup, true);
  assert.equal(session.done, false);
  assert.equal(existsSync(envPath), true, "still there until the final page asks");
  assert.equal(saved[0]?.clientSecret, "VAULT_SECRET_VALUE", "the MCP reads local.json at runtime");
  assert.deepEqual(registered, ["bob"]);

  const final = await session.cleanup();
  assert.equal(final.needsCleanup, false);
  assert.equal(final.cleaned, true);
  assert.equal(session.done, true);
  assert.equal(existsSync(envPath), false);
  assert.ok(!JSON.stringify(final).includes("VAULT_SECRET_VALUE"));
});

test("install before unlocking is refused", async () => {
  await assert.rejects(make().session.install(["id-a"]), /Unlock first/);
});

test("a Pipedream failure removes the temp credentials and returns to the key page to retry", async () => {
  let fail = true;
  const { session } = make({
    list: async () => {
      if (fail) throw new Error("Pipedream list accounts failed (401)");
      return CLIENTS;
    },
  });
  await session.unlock(GOOD_KEY);
  const s = await until(session, "key");
  assert.match(s.error ?? "", /Could not load clients from Pipedream: .*401/);
  assert.equal(existsSync(envPath), false);

  fail = false;
  await session.unlock(GOOD_KEY);
  assert.equal((await until(session, "select")).error, undefined);
});

test("an unreachable vault shows a plain message and writes nothing", async () => {
  const { session } = make({
    fetchCredentials: async () => {
      throw new UserError("Can't reach the access server. Check your connection and try again.");
    },
  });
  await assert.rejects(session.unlock(GOOD_KEY), /Can't reach the access server/);
  assert.equal(existsSync(envPath), false);
  assert.equal((await session.state()).stage, "key");
});

test("dispose (exit or Ctrl-C) removes the temp credentials at any stage", async () => {
  const { session } = make({ list: () => new Promise(() => {}) });
  await session.unlock(GOOD_KEY);
  assert.equal(existsSync(envPath), true);
  session.dispose();
  assert.equal(existsSync(envPath), false);
  session.dispose();
});

test("if the final page never runs, the fallback removes the credentials and lets the CLI finish", async () => {
  const { session } = make({ fallbackCleanupMs: 20 });
  await session.unlock(GOOD_KEY);
  await until(session, "select");
  await session.install(["id-a"]);
  await session.fallbackDone;
  assert.equal(existsSync(envPath), false);
  assert.equal(session.done, true);
});

test("a file that already holds Pipedream credentials is never overwritten or deleted", async () => {
  const own = "PIPEDREAM_CLIENT_ID=mine\nPIPEDREAM_CLIENT_SECRET=mine-secret\n";
  writeFileSync(envPath, own);
  const { session } = make();
  await assert.rejects(session.unlock(GOOD_KEY), /already contains Pipedream credentials/);
  assert.equal((await session.state()).stage, "key");
  session.dispose();
  assert.equal(readFileSync(envPath, "utf8"), own);
});

test("over HTTP: key page, unlock, pick, install, final page cleanup, finished", async () => {
  const { session } = make();
  const server = await startLocalServer(vaultController(session));
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
    const enter = await call(`/?s=${nonce}`);
    const cookie = String((enter.headers["set-cookie"] as string[])[0]).split(";")[0]!;
    const h = { cookie, origin: `http://127.0.0.1:${server.port}` };

    const page = await call("/", { headers: { cookie } });
    assert.match(page.body, /mvs-key-input/);
    assert.equal(JSON.parse((await call("/api/state", { headers: { cookie } })).body).stage, "key");

    assert.equal((await call("/api/unlock", { method: "POST", headers: { cookie }, body: { key: GOOD_KEY } })).status, 403, "Origin required");
    const wrong = await call("/api/unlock", { method: "POST", headers: h, body: { key: "WRONG" } });
    assert.equal(wrong.status, 400);
    assert.match(JSON.parse(wrong.body).message, /didn't work/);
    assert.equal((await call("/api/install", { method: "POST", headers: h, body: { clientIds: ["id-a"] } })).status, 400);

    assert.equal((await call("/api/unlock", { method: "POST", headers: h, body: { key: GOOD_KEY } })).status, 200);
    await until(session, "select");
    assert.ok(!(await call("/api/state", { headers: { cookie } })).body.includes("VAULT_SECRET_VALUE"));

    const inst = JSON.parse((await call("/api/install", { method: "POST", headers: h, body: { clientIds: ["id-a"] } })).body);
    assert.equal(inst.stage, "done");
    assert.equal(inst.needsCleanup, true);
    assert.equal(existsSync(envPath), true);

    const fin = await call("/api/cleanup", { method: "POST", headers: h, body: {} });
    assert.equal(JSON.parse(fin.body).cleaned, true);
    await server.finished;
    assert.equal(existsSync(envPath), false);
  } finally {
    server.close();
    session.dispose();
  }
});

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import pino from "pino";
import { ENV, harness } from "./helpers.js";
import { FileStore } from "../src/store.js";
import { clientIp, dispatch } from "../src/http.js";
import { routes } from "../src/routes.js";
import { findKey, generateKey, hashKey, issueKey, listKeys, normalizeKey, recordUse, revokeKey } from "../src/vault.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mavis-vault-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("keys: 25 Crockford characters, unique, forgiving to type", () => {
  const keys = new Set(Array.from({ length: 200 }, generateKey));
  assert.equal(keys.size, 200);
  for (const k of keys) assert.match(k, /^[0-9A-HJKMNP-TV-Z]{5}(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
  const k = generateKey();
  assert.equal(normalizeKey(k.toLowerCase().replace(/-/g, " ")), normalizeKey(k));
  assert.equal(normalizeKey("OOOOO-IIIII-LLLLL-00000-11111"), "0000011111111110000011111");
  for (const bad of ["", "short", k + "A", "UUUUU-UUUUU-UUUUU-UUUUU-UUUUU", "!!!!!-!!!!!-!!!!!-!!!!!-!!!!!"]) assert.equal(normalizeKey(bad), null, bad);
});

test("issueKey stores only a hash; find, expire and revoke behave", async () => {
  const h = harness();
  const { key, record } = await issueKey(h.store, { label: "Pat", expiresInDays: 30 }, h.clock.now);
  const stored = JSON.stringify(await h.store.get(`vkey:${record.id}`));
  assert.ok(!stored.includes(key) && !stored.includes(normalizeKey(key) as string), "the key itself is never stored");
  assert.equal(record.id, hashKey(normalizeKey(key) as string).id);

  const ok = await findKey(h.store, key.toLowerCase(), h.clock.now);
  assert.equal(ok.ok, true);
  assert.deepEqual(await findKey(h.store, generateKey(), h.clock.now), { ok: false, reason: "unknown" });
  assert.deepEqual(await findKey(h.store, "nope", h.clock.now), { ok: false, reason: "malformed" });
  assert.deepEqual(await findKey(h.store, key, h.clock.now + 31 * 86_400_000), { ok: false, reason: "expired" });

  await revokeKey(h.store, record.id);
  assert.deepEqual(await findKey(h.store, key, h.clock.now), { ok: false, reason: "revoked" });
  assert.equal(await revokeKey(h.store, "doesnotexist"), null);
  await assert.rejects(issueKey(h.store, { label: "  " }), /label/);
  assert.equal((await listKeys(h.store)).length, 1);
});

test("credentials route: a valid key gets the Pipedream credentials, no-store", async () => {
  const h = harness();
  const { key } = await issueKey(h.store, { label: "Pat" }, h.clock.now);
  const req = new Request("https://vault.test/api/credentials", { method: "POST", headers: { authorization: `Bearer ${key}`, "x-real-ip": "9.9.9.9" } });
  const res = await dispatch(routes.credentials, req, h.deps);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(await res.json(), { clientId: "cid_test", clientSecret: "super-secret-value", projectId: "proj_test", environment: "production" });

  const used = (await listKeys(h.store))[0]!;
  assert.equal(used.uses, 1);
  assert.ok(used.lastUsedAt);
});

test("the credentials route accepts a key pasted with spaces in the header", async () => {
  const h = harness();
  const { key } = await issueKey(h.store, { label: "Pat" }, h.clock.now);
  for (const presented of [key.replace(/-/g, " "), key.toLowerCase().replace(/-/g, "  ")]) {
    const req = new Request("https://vault.test/api/credentials", { method: "POST", headers: { authorization: `Bearer ${presented}`, "x-real-ip": "3.3.3.3" } });
    assert.equal((await dispatch(routes.credentials, req, h.deps)).status, 200, presented);
  }
});

test("every failure looks identical: wrong, malformed, missing, revoked and expired keys", async () => {
  const h = harness();
  const good = await issueKey(h.store, { label: "Pat" }, h.clock.now);
  const revoked = await issueKey(h.store, { label: "Gone" }, h.clock.now);
  await revokeKey(h.store, revoked.record.id);
  const expired = await issueKey(h.store, { label: "Old", expiresInDays: 1 }, h.clock.now - 5 * 86_400_000);

  const bodies = new Set<string>();
  for (const token of [generateKey(), "garbage", revoked.key, expired.key, undefined]) {
    const r = await h.call("credentials", { token, ip: "7.7.7.7" });
    assert.equal(r.status, 401);
    bodies.add(JSON.stringify(r.body));
  }
  assert.equal(bodies.size, 1, "one response for every reason");
  assert.equal((await h.call("credentials", { token: good.key, ip: "7.7.7.7" })).status, 200);
});

test("attempts per IP are capped over 15 minutes, even when each minute is within its own limit", async () => {
  const h = harness();
  let last = 0;
  for (let i = 0; i < 31; i++) {
    h.clock.now += 61_000;
    last = (await h.call("credentials", { token: generateKey(), ip: "6.6.6.6" })).status;
  }
  assert.equal(last, 429);
  const other = await h.call("credentials", { token: generateKey(), ip: "5.5.5.5" });
  assert.equal(other.status, 401, "another address is unaffected");
});

test("logs record who got credentials but never the key or the secret", async () => {
  const lines: string[] = [];
  const stream = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
  const h = harness();
  const deps = { ...h.deps, log: pino({ level: "info" }, stream) };
  const { key } = await issueKey(h.store, { label: "Pat" }, h.clock.now);
  const wrong = generateKey();
  for (const token of [key, wrong]) {
    await dispatch(routes.credentials, new Request("https://vault.test/api/credentials", { method: "POST", headers: { authorization: `Bearer ${token}`, "x-real-ip": "4.4.4.4" } }), deps);
  }
  const text = lines.join("");
  assert.match(text, /credentials issued/);
  assert.match(text, /credentials request refused/);
  assert.match(text, /"label":"Pat"/);
  for (const secret of [key, normalizeKey(key) as string, wrong, ENV.PIPEDREAM_CLIENT_SECRET, ENV.PIPEDREAM_CLIENT_ID]) assert.ok(!text.includes(secret), "log must not contain secrets");
});

test("GET and other paths are refused; the proxy-set address wins over a spoofed X-Forwarded-For", async () => {
  const h = harness();
  assert.equal((await h.call("credentials", { method: "GET", token: generateKey() })).status, 405);
  const spoof = new Request("https://vault.test/x", { headers: { "x-real-ip": "1.1.1.1", "x-forwarded-for": "8.8.8.8, 1.1.1.1" } });
  assert.equal(clientIp(spoof), "1.1.1.1");
  assert.equal(clientIp(new Request("https://vault.test/x", { headers: { "x-forwarded-for": "8.8.8.8, 1.1.1.1" } })), "8.8.8.8");
  assert.equal(clientIp(new Request("https://vault.test/x")), "unknown");
});

test("FileStore persists across restarts, files are 0600 in a 0700 directory, counters stay in memory", async () => {
  const path = join(dir, "state");
  const a = new FileStore(path);
  await a.set("k", { n: 1 });
  await a.sadd("s", "x");
  await a.sadd("s", "x");
  assert.equal(await a.incr("c", 60), 1);
  assert.equal(await a.incr("c", 60), 2);
  assert.equal(statSync(path).mode & 0o777, 0o700);
  const files = [...readdirSync(join(path, "kv")), ...readdirSync(join(path, "sets"))];
  assert.equal(files.length, 2, "one file per record, nothing for counters");
  for (const sub of ["kv", "sets"]) for (const f of readdirSync(join(path, sub))) assert.equal(statSync(join(path, sub, f)).mode & 0o777, 0o600, f);
  assert.ok(files.every((f) => !f.endsWith(".tmp")), "no temp file left behind");

  const b = new FileStore(path);
  assert.deepEqual(await b.get("k"), { n: 1 });
  assert.deepEqual(await b.smembers("s"), ["x"]);
  assert.equal(await b.get("missing"), null);
  assert.deepEqual(await b.smembers("nothing"), []);
  await b.del("k");
  await b.del("k");
  assert.equal(await new FileStore(path).get("k"), null);
});

test("an admin acting on a separate process is seen by the running server at once, and server writes never undo it", async () => {
  const path = join(dir, "state");
  const server = new FileStore(path); // the running service
  const admin = new FileStore(path); // the CLI, a different process in real life

  const { key, record } = await issueKey(admin, { label: "Pat" });
  assert.equal((await findKey(server, key)).ok, true, "a key issued while the server runs works immediately, no restart");
  assert.equal((await listKeys(server)).length, 1);

  await recordUse(server, record);
  await revokeKey(admin, record.id);
  assert.deepEqual(await findKey(server, key), { ok: false, reason: "revoked" }, "revocation takes effect immediately");

  await recordUse(server, record); // a request that was already in flight
  assert.deepEqual(await findKey(server, key), { ok: false, reason: "revoked" }, "usage bookkeeping cannot bring a revoked key back");
  const [view] = await listKeys(admin);
  assert.equal(view?.status, "revoked");
  assert.equal(view?.uses, 2);
});

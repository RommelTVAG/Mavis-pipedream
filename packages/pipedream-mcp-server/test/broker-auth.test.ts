import { test } from "node:test";
import assert from "node:assert/strict";
import { BrokerAuthManager, BrokerError } from "../src/broker-auth.js";

function fakeFetch(handler: (n: number, init?: RequestInit) => Response) {
  let n = 0;
  const calls: Array<{ url: string; auth: string | null }> = [];
  const f: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
    return handler(++n, init);
  };
  return { f, calls };
}

const ok = (extra: object = {}) =>
  Response.json({ accessToken: "pd1", expiresIn: 3600, projectId: "proj", environment: "production", externalUserId: "cust_a", clientName: "Acme", ...extra });

test("caches the access token and sends the install token as bearer", async () => {
  const { f, calls } = fakeFetch(() => ok());
  const auth = new BrokerAuthManager("https://broker.test", "install_tok", undefined, f);
  assert.equal(await auth.getToken(), "pd1");
  assert.equal(await auth.getToken(), "pd1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, "https://broker.test/api/access-token");
  assert.equal(calls[0]?.auth, "Bearer install_tok");
  assert.equal((await auth.getSession()).externalUserId, "cust_a");
});

test("concurrent callers share one refresh", async () => {
  const { f, calls } = fakeFetch(() => ok());
  const auth = new BrokerAuthManager("https://broker.test", "t", undefined, f);
  await Promise.all([auth.getToken(), auth.getToken(), auth.getToken()]);
  assert.equal(calls.length, 1);
});

test("refreshes when within 5 minutes of expiry", async () => {
  const { f, calls } = fakeFetch((n) => ok({ expiresIn: n === 1 ? 200 : 3600 }));
  const auth = new BrokerAuthManager("https://broker.test", "t", undefined, f);
  await auth.getToken();
  await auth.getToken();
  assert.equal(calls.length, 2);
});

test("401/403 gives an actionable error", async () => {
  for (const status of [401, 403]) {
    const { f } = fakeFetch(() => new Response("{}", { status }));
    const auth = new BrokerAuthManager("https://broker.test", "t", undefined, f);
    await assert.rejects(auth.getToken(), (e: unknown) => e instanceof BrokerError && /new setup code/.test(e.message) && e.status === status);
  }
});

test("renewed install token is persisted and used on the next call", async () => {
  const renewed: string[] = [];
  const { f, calls } = fakeFetch((n) => ok({ expiresIn: n === 1 ? 100 : 3600, renewedToken: n === 1 ? "fresh_tok" : undefined }));
  const auth = new BrokerAuthManager("https://broker.test", "old_tok", (t) => renewed.push(t), f);
  await auth.getToken();
  await auth.getToken();
  assert.deepEqual(renewed, ["fresh_tok"]);
  assert.equal(calls[1]?.auth, "Bearer fresh_tok");
});

test("a failing persist of the renewed token does not break auth", async () => {
  const { f } = fakeFetch(() => ok({ renewedToken: "x" }));
  const auth = new BrokerAuthManager("https://broker.test", "t", () => { throw new Error("disk full"); }, f);
  assert.equal(await auth.getToken(), "pd1");
});

test("rejects non-https broker URLs except loopback", () => {
  assert.throws(() => new BrokerAuthManager("http://evil.test", "t"), /https/);
  assert.doesNotThrow(() => new BrokerAuthManager("http://127.0.0.1:8787", "t"));
});

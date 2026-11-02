import { test } from "node:test";
import assert from "node:assert/strict";
import { harness } from "./helpers.js";
import { recordKey, type CodeRecord } from "../src/codes.js";
import { newClaims, signToken } from "../src/tokens.js";
import { ENV } from "./helpers.js";

async function enrolled(h = harness()) {
  const { secret, id } = await h.issue();
  const sel = await h.call("select", { token: secret, body: { clientIds: ["cust_a", "cust_b"] } });
  assert.equal(sel.status, 200);
  const tokens: Record<string, string> = Object.fromEntries(sel.body.clients.map((c: any) => [c.id, c.token]));
  return { h, secret, id, tokens };
}

test("enroll returns only the allowlisted clients; bad code is 401", async () => {
  const h = harness();
  const { secret } = await h.issue();
  const ok = await h.call("enroll", { token: secret });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.clients.map((c: any) => c.id), ["cust_a", "cust_b", "cust_c"]);

  assert.equal((await h.call("enroll", { token: "wrong" })).status, 401);
  assert.equal((await h.call("enroll")).status, 401);
});

test("select rejects clients outside the allowlist and empty selections", async () => {
  const h = harness();
  const { secret } = await h.issue();
  assert.equal((await h.call("select", { token: secret, body: { clientIds: ["cust_a", "someone_else"] } })).status, 400);
  assert.equal((await h.call("select", { token: secret, body: { clientIds: [] } })).status, 400);
  assert.equal((await h.call("select", { token: secret, body: {} })).status, 400);
});

test("install token only reaches its own client; external_user_id comes from the token", async () => {
  const { h, tokens } = await enrolled();
  const r = await h.call("connectToken", { token: tokens.cust_a, body: { app: "slack", external_user_id: "cust_b" } });
  assert.equal(r.status, 200);
  const tokenCall = h.calls.find((c) => c.url.endsWith("/tokens"));
  assert.equal((tokenCall?.body as any).external_user_id, "cust_a");
  assert.match(r.body.connectLinkUrl, /app=slack/);

  const list = await h.call("accounts", { token: tokens.cust_b });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.accounts, [{ id: "apn_1", appSlug: "slack", appName: "Slack", healthy: true }]);
  const accountsCall = h.calls.find((c) => c.url.includes("/accounts"));
  assert.match(accountsCall!.url, /external_user_id=cust_b/);
});

test("a validly signed token for a client that was not selected is refused", async () => {
  const { h, id } = await enrolled();
  const forged = signToken(newClaims(id, "cust_c", h.clock.now), ENV.BROKER_SIGNING_KEY);
  const r = await h.call("accessToken", { token: forged });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "client_not_selected");
});

test("re-selecting before finalize invalidates tokens of deselected clients", async () => {
  const { h, secret, tokens } = await enrolled();
  assert.equal((await h.call("accessToken", { token: tokens.cust_b })).status, 200);
  await h.call("select", { token: secret, body: { clientIds: ["cust_a"] } });
  assert.equal((await h.call("accessToken", { token: tokens.cust_b })).status, 403);
  assert.equal((await h.call("accessToken", { token: tokens.cust_a })).status, 200);
});

test("finalize seals: no more enroll/select/finalize, but install tokens keep working", async () => {
  const { h, secret, tokens } = await enrolled();
  const fin = await h.call("finalize", { token: secret });
  assert.equal(fin.status, 200);

  assert.equal((await h.call("enroll", { token: secret })).status, 409);
  const reselect = await h.call("select", { token: secret, body: { clientIds: ["cust_c"] } });
  assert.equal(reselect.status, 409);
  assert.equal((await h.call("finalize", { token: secret })).status, 409);

  assert.equal((await h.call("accessToken", { token: tokens.cust_a })).status, 200);
  assert.equal((await h.call("connectToken", { token: tokens.cust_b, body: { app: "gmail" } })).status, 200);
});

test("finalize without a selection is refused", async () => {
  const h = harness();
  const { secret } = await h.issue();
  assert.equal((await h.call("finalize", { token: secret })).status, 400);
});

test("revoking the code kills enrollment and every install token", async () => {
  const { h, id, tokens } = await enrolled();
  const rec = (await h.store.get<CodeRecord>(recordKey(id)))!;
  await h.store.set(recordKey(id), { ...rec, status: "revoked" });
  assert.equal((await h.call("accessToken", { token: tokens.cust_a })).status, 401);
});

test("redirectUri must be the loopback callback; app slug is validated", async () => {
  const { h, tokens } = await enrolled();
  for (const bad of ["https://evil.example/callback", "http://127.0.0.1:99999999/callback", "http://localhost:4000/callback", "http://127.0.0.1:4000/other"]) {
    assert.equal((await h.call("connectToken", { token: tokens.cust_a, body: { redirectUri: bad } })).status, 400, bad);
  }
  assert.equal((await h.call("connectToken", { token: tokens.cust_a, body: { app: "Slack; DROP" } })).status, 400);
  const ok = await h.call("connectToken", { token: tokens.cust_a, body: { redirectUri: "http://127.0.0.1:43210/callback" } });
  assert.equal(ok.status, 200);
  const tokenCall = h.calls.find((c) => c.url.endsWith("/tokens"));
  assert.equal((tokenCall?.body as any).success_redirect_uri, "http://127.0.0.1:43210/callback");
});

test("connect link must be on pipedream.com", async () => {
  const h = harness({ connectLinkUrl: "https://evil.example/phish" });
  const { tokens } = await enrolled(h);
  const r = await h.call("connectToken", { token: tokens.cust_a, body: {} });
  assert.equal(r.status, 502);
});

test("access-token returns session info, never the client secret; renews near expiry", async () => {
  const { h, tokens } = await enrolled();
  const r = await h.call("accessToken", { token: tokens.cust_a });
  assert.equal(r.status, 200);
  assert.equal(r.body.accessToken, "pd_access");
  assert.equal(r.body.externalUserId, "cust_a");
  assert.equal(r.body.projectId, "proj_test");
  assert.equal(r.body.clientName, "Acme");
  assert.equal(r.body.renewedToken, undefined);
  assert.ok(!JSON.stringify(r.body).includes("super-secret-value"));

  h.clock.now += 70 * 24 * 3600 * 1000; // 20 days left of 90
  const later = await h.call("accessToken", { token: tokens.cust_a });
  assert.equal(later.status, 200);
  assert.ok(typeof later.body.renewedToken === "string");
  assert.equal((await h.call("accessToken", { token: later.body.renewedToken })).status, 200);
});

test("pipedream project token is cached across calls", async () => {
  const { h, tokens } = await enrolled();
  await h.call("accessToken", { token: tokens.cust_a });
  await h.call("accessToken", { token: tokens.cust_b });
  assert.equal(h.calls.filter((c) => c.url.endsWith("/oauth/token")).length, 1);
});

test("wrong method is 405; rate limit returns 429; health is open", async () => {
  const h = harness();
  assert.equal((await h.call("enroll", { method: "GET" })).status, 405);
  assert.equal((await h.call("health")).status, 200);
  let last = 0;
  for (let i = 0; i < 25; i++) last = (await h.call("enroll", { token: "x", ip: "9.9.9.9" })).status;
  assert.equal(last, 429);
});

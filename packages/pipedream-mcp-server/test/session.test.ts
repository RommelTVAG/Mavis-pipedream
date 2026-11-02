import { test } from "node:test";
import assert from "node:assert/strict";
import { SetupSession, UserError } from "../src/setup/session.js";
import type { Credentials } from "../src/credentials.js";
import type { RegisterResult } from "../src/setup/register.js";
import { asClient, FakeBroker } from "./fakes.js";

function make(opts: { existing?: Credentials | null; secret?: string | null } = {}) {
  const broker = new FakeBroker();
  const saved: Credentials[] = [];
  const registered: string[] = [];
  const secret = opts.secret === null ? undefined : (opts.secret ?? "sekret");
  const promise = SetupSession.start({
    broker: asClient(broker),
    brokerUrl: "https://broker.test",
    secret,
    existing: opts.existing ?? null,
    entryPath: "/x/dist/index.js",
    registerWithClaude: false,
    save: (c) => void saved.push(JSON.parse(JSON.stringify(c))),
    register: (slug): RegisterResult => {
      registered.push(slug);
      return { name: `pipedream-${slug}`, ok: true, manualCommand: "" };
    },
  });
  return { broker, saved, registered, promise };
}

test("enroll flow: select, connect, lock; credentials saved before sealing", async () => {
  const { broker, saved, registered, promise } = make();
  const s = await promise;
  assert.equal((await s.state()).stage, "select");

  await s.select(["cust_a", "cust_b"]);
  const st = await s.state();
  assert.equal(st.stage, "connect");
  assert.deepEqual(st.selected.map((c) => c.id), ["cust_a", "cust_b"]);

  const link = await s.connect("cust_a", " Slack ", "http://127.0.0.1:1/callback");
  assert.match(link, /app=slack/);
  assert.ok(broker.log.includes("connect:tok_cust_a:slack"));

  await assert.rejects(s.finish("lock"), UserError);
  await assert.rejects(s.finish(""), UserError);
  assert.equal(broker.sealed, false);

  await s.finish("LOCK");
  assert.equal(s.done, true);
  assert.equal(saved.length, 2);
  assert.equal(saved[0]?.sealed, false);
  assert.equal(saved[1]?.sealed, true);
  assert.ok(broker.log.indexOf("finalize") > -1);
  assert.deepEqual(saved[1]?.clients.map((c) => [c.slug, c.token]), [["acme-corp", "tok_cust_a"], ["beta-llc", "tok_cust_b"]]);
  assert.deepEqual(registered, ["acme-corp", "beta-llc"]);
});

test("a failed finalize leaves usable (unsealed) credentials on disk", async () => {
  const { broker, saved, promise } = make();
  const s = await promise;
  await s.select(["cust_a"]);
  broker.failFinalize = true;
  await assert.rejects(s.finish("LOCK"));
  assert.equal(saved.length, 1);
  assert.equal(saved[0]?.sealed, false);
  assert.equal(saved[0]?.clients[0]?.token, "tok_cust_a");
  assert.equal(s.done, false);
});

test("guards: nothing selected, wrong stage, foreign client, bad app slug", async () => {
  const s = await make().promise;
  await assert.rejects(s.select([]), UserError);
  await assert.rejects(s.connect("cust_a", "slack", "http://127.0.0.1:1/callback"), UserError);
  await assert.rejects(s.finish("LOCK"), UserError);

  await s.select(["cust_a"]);
  await assert.rejects(s.select(["cust_b"]), UserError);
  await assert.rejects(s.connect("cust_c", "slack", "http://127.0.0.1:1/callback"), /not part of this install/);
  await assert.rejects(s.connect("cust_a", "Slack; rm", "http://127.0.0.1:1/callback"), UserError);
});

test("manage mode: needs a sealed install, uses stored tokens, no finalize", async () => {
  await assert.rejects(make({ secret: null }).promise, /Nothing to manage/);

  const existing: Credentials = {
    version: 1,
    broker: "https://broker.test",
    sealed: true,
    clients: [{ id: "cust_a", name: "Acme Corp", slug: "acme-corp", token: "stored_tok" }],
  };
  const { broker, saved, promise } = make({ existing, secret: null });
  const s = await promise;
  const st = await s.state();
  assert.equal(st.mode, "manage");
  assert.equal(st.stage, "connect");
  assert.deepEqual(st.selected.map((c) => c.slug), ["acme-corp"]);

  await s.connect("cust_a", "gmail", "http://127.0.0.1:1/callback");
  assert.ok(broker.log.includes("connect:stored_tok:gmail"));
  await assert.rejects(s.connect("cust_b", "gmail", "http://127.0.0.1:1/callback"), UserError);

  await s.finish("");
  assert.equal(s.done, true);
  assert.equal(saved.length, 0);
  assert.ok(!broker.log.includes("finalize"));
});

test("new code on an existing install merges and keeps existing slugs", async () => {
  const existing: Credentials = {
    version: 1,
    broker: "https://broker.test",
    sealed: true,
    clients: [{ id: "cust_a", name: "Acme Corp", slug: "acme-corp", token: "old" }],
  };
  const { saved, promise } = make({ existing });
  const s = await promise;
  await s.select(["cust_b"]);
  await s.finish("LOCK");
  assert.deepEqual(saved[1]?.clients.map((c) => c.slug), ["acme-corp", "beta-llc"]);
  assert.equal(saved[1]?.clients[0]?.token, "old");
});

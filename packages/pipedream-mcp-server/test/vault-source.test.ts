import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchCredentials, normalizeKey } from "../src/setup/vault-source.js";
import { UserError } from "../src/setup/session.js";

const KEY = "70VN4-69M6K-375BQ-T0X53-DGZBZ";
const OK = { clientId: "cid", clientSecret: "SECRET_FROM_VAULT", projectId: "proj_1", environment: "production" };

function fake(status: number, body: unknown = OK) {
  const seen: Array<{ url: string; method?: string; auth: string | null; body: unknown }> = [];
  const f: typeof fetch = async (input, init) => {
    seen.push({ url: String(input), method: init?.method, auth: new Headers(init?.headers).get("authorization"), body: init?.body });
    return typeof body === "string" ? new Response(body, { status }) : Response.json(body, { status });
  };
  return { f, seen };
}

test("normalizeKey matches the server's rules", () => {
  assert.equal(normalizeKey(KEY.toLowerCase().replace(/-/g, " ")), normalizeKey(KEY));
  assert.equal(normalizeKey("short"), null);
  assert.equal(normalizeKey("UUUUU-UUUUU-UUUUU-UUUUU-UUUUU"), null);
});

test("sends the key as a bearer token with POST and no body, and returns the credentials", async () => {
  const { f, seen } = fake(200);
  const out = await fetchCredentials("https://vault.example.com", `  ${KEY.toLowerCase()}  `, f);
  assert.deepEqual(out, OK);
  assert.equal(seen[0]?.url, "https://vault.example.com/api/credentials");
  assert.equal(seen[0]?.method, "POST");
  assert.equal(seen[0]?.auth, `Bearer ${KEY}`);
  assert.equal(seen[0]?.body, undefined);
});

test("a key typed with spaces, lowercase or look-alike letters is sent in canonical form (spaces would break the header)", async () => {
  for (const typed of [KEY.toLowerCase().replace(/-/g, " "), `  ${KEY.replace(/-/g, "  ")}  `, KEY.toLowerCase()]) {
    const { f, seen } = fake(200);
    await fetchCredentials("https://vault.example.com", typed, f);
    assert.equal(seen[0]?.auth, `Bearer ${KEY}`, typed);
  }
  const { f, seen } = fake(200);
  await fetchCredentials("https://vault.example.com", KEY.replace("0", "O"), f);
  assert.equal(seen[0]?.auth, `Bearer ${KEY}`, "O is read as 0");
});

test("a key that cannot be valid is refused before any network call", async () => {
  const { f, seen } = fake(200);
  await assert.rejects(fetchCredentials("https://vault.example.com", "nope", f), /doesn't look right/);
  assert.equal(seen.length, 0);
});

test("refusals map to fixed, safe messages that never include the key or the response", async () => {
  const cases: Array<[number, RegExp]> = [[401, /didn't work/], [429, /Too many attempts/], [500, /had a problem \(500\)/], [503, /had a problem \(503\)/]];
  for (const [status, re] of cases) {
    const { f } = fake(status, { message: `leaked ${KEY} SECRET_FROM_VAULT` });
    await assert.rejects(fetchCredentials("https://vault.example.com", KEY, f), (e: Error) => e instanceof UserError && re.test(e.message) && !e.message.includes(KEY) && !e.message.includes("SECRET_FROM_VAULT"), String(status));
  }
});

test("network failure gives a plain message without the underlying error text", async () => {
  const f: typeof fetch = async () => {
    throw new Error(`getaddrinfo ENOTFOUND vault.example.com while sending ${KEY}`);
  };
  await assert.rejects(fetchCredentials("https://vault.example.com", KEY, f), (e: Error) => /Can't reach the access server/.test(e.message) && !e.message.includes(KEY));
});

test("a malformed or incomplete answer is rejected", async () => {
  for (const body of [{}, { ...OK, clientSecret: "" }, { ...OK, environment: "staging" }, { clientId: "x" }, "not json"]) {
    const { f } = fake(200, body);
    await assert.rejects(fetchCredentials("https://vault.example.com", KEY, f), /unexpected answer/);
  }
});

test("plain http is only allowed for localhost (tunnels in testing)", async () => {
  const { f } = fake(200);
  await assert.rejects(fetchCredentials("http://vault.example.com", KEY, f), /https/);
  await assert.doesNotReject(fetchCredentials("http://127.0.0.1:14021", KEY, f));
});

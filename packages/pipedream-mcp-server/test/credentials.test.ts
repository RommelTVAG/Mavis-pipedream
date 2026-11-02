import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialsPath, readCredentials, updateClientToken, writeCredentials, type Credentials } from "../src/credentials.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mavis-test-"));
  process.env.MAVIS_HOME = join(dir, "home");
});
afterEach(() => {
  delete process.env.MAVIS_HOME;
  rmSync(dir, { recursive: true, force: true });
});

const creds: Credentials = {
  version: 1,
  broker: "https://b.test",
  sealed: true,
  clients: [{ id: "a", name: "A", slug: "a", token: "t" }],
};

test("missing file reads as null; round trip works", () => {
  assert.equal(readCredentials(), null);
  writeCredentials(creds);
  assert.deepEqual(readCredentials(), creds);
});

test("directory is 0700 and file is 0600", { skip: process.platform === "win32" }, () => {
  writeCredentials(creds);
  assert.equal(statSync(join(dir, "home")).mode & 0o777, 0o700);
  assert.equal(statSync(credentialsPath()).mode & 0o777, 0o600);
});

test("malformed file is rejected with guidance", () => {
  mkdirSync(join(dir, "home"), { recursive: true });
  writeFileSync(credentialsPath(), JSON.stringify({ version: 1, clients: "nope" }));
  assert.throws(() => readCredentials(), /malformed/);
});

test("updateClientToken swaps only the matching client's token", () => {
  writeCredentials({ ...creds, clients: [...creds.clients, { id: "b", name: "B", slug: "b", token: "tb" }] });
  updateClientToken("a", "new");
  const r = readCredentials()!;
  assert.equal(r.clients[0]?.token, "new");
  assert.equal(r.clients[1]?.token, "tb");
  updateClientToken("zzz", "ignored");
});

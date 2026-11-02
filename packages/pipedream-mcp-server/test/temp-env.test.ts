import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeStaleBlock, writeTempEnv } from "../src/setup/temp-env.js";
import { parseEnvFile } from "../src/setup/env-file.js";

const P = { clientId: "cid", clientSecret: "SECRET_VALUE", projectId: "proj_1", environment: "production" };
let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mavis-tmpenv-"));
  file = join(dir, "env.local");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

test("creates the file (mode 600) readable by the env loader, and cleanup deletes it", () => {
  const t = writeTempEnv(file, P);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(
    parseEnvFile(readFileSync(file, "utf8")),
    { PIPEDREAM_CLIENT_ID: "cid", PIPEDREAM_CLIENT_SECRET: "SECRET_VALUE", PIPEDREAM_PROJECT_ID: "proj_1", PIPEDREAM_PROJECT_ENVIRONMENT: "production" },
  );
  t.cleanup();
  assert.equal(existsSync(file), false);
  t.cleanup(); // idempotent
});

test("appends to a file with other content and removes only its own block", () => {
  writeFileSync(file, "#PIPEDREAM\nOTHER=keep-me\nNO_NEWLINE=1");
  const t = writeTempEnv(file, P);
  assert.match(readFileSync(file, "utf8"), /NO_NEWLINE=1\n# >>> MAVIS TEMPORARY/);
  t.cleanup();
  assert.equal(readFileSync(file, "utf8"), "#PIPEDREAM\nOTHER=keep-me\nNO_NEWLINE=1\n");
  assert.ok(!readFileSync(file, "utf8").includes("SECRET_VALUE"));
});

test("refuses to touch a file that already holds Pipedream credentials", () => {
  const own = "PIPEDREAM_CLIENT_ID=mine\nPIPEDREAM_CLIENT_SECRET=mine-secret\n";
  writeFileSync(file, own);
  assert.throws(() => writeTempEnv(file, P), /already contains Pipedream credentials/);
  assert.equal(readFileSync(file, "utf8"), own, "the user's file is untouched");
});

test("a block left by a crashed run is removed before the next run", () => {
  writeTempEnv(file, P); // simulate a crash: no cleanup
  assert.equal(removeStaleBlock(file), true);
  assert.equal(existsSync(file), false);
  writeTempEnv(file, P);
  const second = writeTempEnv(file, { ...P, clientSecret: "SECOND" });
  assert.ok(!readFileSync(file, "utf8").includes("SECRET_VALUE"));
  assert.match(readFileSync(file, "utf8"), /SECOND/);
  second.cleanup();
  assert.equal(existsSync(file), false);
});

test("cleanup tolerates the file being deleted or edited by someone else", () => {
  const t = writeTempEnv(file, P);
  rmSync(file);
  assert.doesNotThrow(() => t.cleanup());
  const t2 = writeTempEnv(file, P);
  writeFileSync(file, "REPLACED=1\n");
  t2.cleanup();
  assert.equal(readFileSync(file, "utf8"), "REPLACED=1\n");
});

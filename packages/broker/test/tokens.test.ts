import { test } from "node:test";
import assert from "node:assert/strict";
import { newClaims, signToken, TOKEN_TTL_SECONDS, verifyToken } from "../src/tokens.js";
import { decodeSetupCode, encodeSetupCode } from "../src/codes.js";

const KEY = "k".repeat(48);
const NOW = Date.UTC(2026, 0, 1);

test("sign/verify round trip", () => {
  const t = signToken(newClaims("cid1", "cust_a", NOW), KEY);
  const claims = verifyToken(t, KEY, NOW);
  assert.equal(claims?.uid, "cust_a");
  assert.equal(claims?.cid, "cid1");
});

test("rejects wrong key, tampered payload, tampered signature, garbage", () => {
  const t = signToken(newClaims("cid1", "cust_a", NOW), KEY);
  assert.equal(verifyToken(t, "x".repeat(48), NOW), null);

  const [payload, sig] = t.split(".") as [string, string];
  const forged = Buffer.from(JSON.stringify({ v: 1, cid: "cid1", uid: "cust_b", exp: 9999999999 })).toString("base64url");
  assert.equal(verifyToken(`${forged}.${sig}`, KEY, NOW), null);
  assert.equal(verifyToken(`${payload}.${sig.slice(0, -2)}AA`, KEY, NOW), null);
  assert.equal(verifyToken("nonsense", KEY, NOW), null);
  assert.equal(verifyToken("a.b.c", KEY, NOW), null);
});

test("rejects expired tokens", () => {
  const t = signToken(newClaims("cid1", "cust_a", NOW), KEY);
  assert.ok(verifyToken(t, KEY, NOW + (TOKEN_TTL_SECONDS - 10) * 1000));
  assert.equal(verifyToken(t, KEY, NOW + (TOKEN_TTL_SECONDS + 10) * 1000), null);
});

test("setup code round trip and rejection of junk", () => {
  const code = encodeSetupCode("https://broker.test", "sekret");
  assert.deepEqual(decodeSetupCode(code), { broker: "https://broker.test", secret: "sekret" });
  assert.equal(decodeSetupCode("mavis_!!!"), null);
  assert.equal(decodeSetupCode("other_abc"), null);
});

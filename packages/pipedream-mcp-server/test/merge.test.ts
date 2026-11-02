import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeCredentials, slugify, uniqueSlug } from "../src/setup/merge.js";

test("slugify produces safe [a-z0-9-] slugs", () => {
  assert.equal(slugify("Acme Corp"), "acme-corp");
  assert.equal(slugify("  Café & Co.  "), "cafe-co");
  assert.equal(slugify("--; rm -rf /"), "rm-rf");
  assert.equal(slugify("日本語"), "client");
  assert.match(slugify("x".repeat(200)), /^x{40}$/);
});

test("uniqueSlug avoids collisions", () => {
  assert.equal(uniqueSlug("Acme", new Set(["acme"])), "acme-2");
  assert.equal(uniqueSlug("Acme", new Set(["acme", "acme-2"])), "acme-3");
});

test("merge appends new clients and keeps slugs of existing ones", () => {
  const first = mergeCredentials(null, "https://b.test", [{ id: "a", name: "Acme", token: "t1" }], true);
  assert.deepEqual(first.clients, [{ id: "a", name: "Acme", slug: "acme", token: "t1" }]);

  const second = mergeCredentials(
    first,
    "https://b.test",
    [
      { id: "a", name: "Acme Renamed", token: "t2" },
      { id: "b", name: "Acme", token: "t3" },
    ],
    true,
  );
  assert.equal(second.clients.find((c) => c.id === "a")?.slug, "acme");
  assert.equal(second.clients.find((c) => c.id === "a")?.token, "t2");
  assert.equal(second.clients.find((c) => c.id === "b")?.slug, "acme-2");
  assert.equal(second.clients.length, 2);
});

test("merge refuses to mix brokers; sealed is sticky", () => {
  const sealed = mergeCredentials(null, "https://b.test", [{ id: "a", name: "A", token: "t" }], true);
  assert.throws(() => mergeCredentials(sealed, "https://other.test", [], true), /refusing to mix/);
  assert.equal(mergeCredentials(sealed, "https://b.test", [{ id: "b", name: "B", token: "t" }], false).sealed, true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppClientLike } from "../src/app-client.js";
import { ToolRegistry, accountKeys } from "../src/tool-registry.js";
import { discoverApps } from "../src/discovery.js";
import type { AppConnection } from "../src/types.js";

const auth = { getToken: async () => "tok" };

/** Fake per-account connection that records which account served each call. */
function fakeFactory(failFor: string[] = []) {
  const calls: string[] = [];
  const factory = (slug: string, accountId: string): AppClientLike => ({
    connect: async () => {
      if (failFor.includes(accountId)) throw new Error("connect refused");
    },
    listTools: async () => [{ name: `${slug}-find-email`, description: "Find email" }],
    callTool: async (name) => {
      calls.push(`${accountId}:${name}`);
      return { content: [{ type: "text", text: accountId }] };
    },
    close: async () => {},
  });
  return { factory, calls };
}

const outlook: AppConnection = {
  slug: "microsoft_outlook",
  name: "Microsoft Outlook Email",
  healthy: true,
  authType: "oauth",
  accounts: [
    { id: "apn_office", name: "office@example.com" },
    { id: "apn_patrick", name: "patrick@example.com" },
    { id: "apn_sam", name: "sam@example.com" },
  ],
};
const github: AppConnection = {
  slug: "github",
  name: "GitHub",
  healthy: true,
  authType: "oauth",
  accounts: [{ id: "apn_gh", name: "some-bot" }],
};

test("accountKeys: email local part, id fallback for empty or shared names", () => {
  assert.deepEqual(
    accountKeys([
      { id: "apn_1", name: "Office@Example.com" },
      { id: "apn_2", name: "patrick@example.com" },
    ]),
    ["office", "patrick"],
  );
  assert.deepEqual(
    accountKeys([
      { id: "apn_1", name: "pat@a.com" },
      { id: "apn_2", name: "pat@b.com" },
      { id: "apn_3", name: null },
      { id: "apn_4", name: "---" },
    ]),
    ["apn_1", "apn_2", "apn_3", "apn_4"],
  );
  assert.deepEqual(accountKeys([{ id: "apn_1", name: "jane-doe-4033" }]), ["jane_doe_4033"]);
});

test("a multi-account app gets one tool set per account, routed to that account", async () => {
  const { factory, calls } = fakeFactory();
  const registry = new ToolRegistry(auth, "proj", "production", "ext", factory);
  await registry.initialize(new Map([[outlook.slug, outlook]]));

  const names = registry.getAllTools().map((t) => t.prefixedName).sort();
  assert.deepEqual(names, [
    "microsoft_outlook-office-microsoft_outlook-find-email",
    "microsoft_outlook-patrick-microsoft_outlook-find-email",
    "microsoft_outlook-sam-microsoft_outlook-find-email",
  ]);
  const office = registry.getAllTools().find((t) => t.prefixedName.includes("-office-"))!;
  assert.match(office.description, /^\[Microsoft Outlook Email · office@example\.com\]/);

  const res = await registry.callTool("microsoft_outlook-office-microsoft_outlook-find-email", {});
  assert.equal((res.content[0] as { text: string }).text, "apn_office");
  await registry.callTool("microsoft_outlook-patrick-microsoft_outlook-find-email", {});
  assert.deepEqual(calls, [
    "apn_office:microsoft_outlook-find-email",
    "apn_patrick:microsoft_outlook-find-email",
  ]);
});

test("a single-account app keeps its original tool names", async () => {
  const { factory } = fakeFactory();
  const registry = new ToolRegistry(auth, "proj", "production", "ext", factory);
  await registry.initialize(new Map([[github.slug, github]]));
  assert.deepEqual(registry.getAllTools().map((t) => t.prefixedName), ["github-github-find-email"]);
  assert.match(registry.getAllTools()[0]!.description, /^\[GitHub\] /);
});

test("one failing account does not hide its siblings, and names stay stable", async () => {
  const { factory } = fakeFactory(["apn_office"]);
  const registry = new ToolRegistry(auth, "proj", "production", "ext", factory);
  await registry.initialize(new Map([[outlook.slug, outlook]]));

  const names = registry.getAllTools().map((t) => t.prefixedName);
  assert.equal(names.length, 2);
  assert.ok(!names.some((n) => n.includes("-office-")));

  const summary = registry.getIntegrationsSummary();
  assert.equal(summary.connected_accounts, 2);
  assert.equal(summary.connected_apps, 1);
  const failed = summary.integrations.find((i) => i.status === "failed")!;
  assert.equal(failed.account, "office@example.com");
  assert.equal(failed.account_id, "apn_office");
});

test("discovery keeps every healthy account per app and skips dead ones", async () => {
  const account = (id: string, slug: string, name: string, healthy = true, dead = false) => ({
    id, name, external_id: "ext", healthy, dead,
    app: { id: "app_" + slug, name_slug: slug, name: slug, auth_type: "oauth", description: "" },
    created_at: "", updated_at: "",
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          account("apn_a", "microsoft_outlook", "office@example.com"),
          account("apn_b", "microsoft_outlook", "sam@example.com", false, true),
          account("apn_c", "microsoft_outlook", " patrick@example.com "),
        ],
        page_info: { total_count: 3, count: 3 },
      }),
    )) as typeof fetch;
  try {
    const apps = await discoverApps(auth, "proj", "production", "ext");
    assert.deepEqual(apps.get("microsoft_outlook")!.accounts, [
      { id: "apn_a", name: "office@example.com" },
      { id: "apn_c", name: "patrick@example.com" },
    ]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

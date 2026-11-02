/**
 * Manage CSA access keys. Run on the VPS as the service user so the state files keep their owner:
 *   sudo -u mavis-vault node dist/scripts/vault-admin.js issue --label "Pat" [--days 90]
 *   sudo -u mavis-vault node dist/scripts/vault-admin.js list
 *   sudo -u mavis-vault node dist/scripts/vault-admin.js revoke <key-id>
 * A key is shown once when issued; only its hash is stored.
 */
import { parseArgs } from "node:util";
import { FileStore } from "../src/store.js";
import { issueKey, listKeys, revokeKey } from "../src/vault.js";

const USAGE = `Usage:
  vault-admin issue --label "<who it is for>" [--days <n>]
  vault-admin list
  vault-admin revoke <key-id>

State directory: $VAULT_STATE_DIR (default /var/lib/mavis-vault/state)`;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n\n${USAGE}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = new FileStore(process.env.VAULT_STATE_DIR ?? "/var/lib/mavis-vault/state");

  if (cmd === "issue") {
    const { values } = parseArgs({ args: rest, options: { label: { type: "string" }, days: { type: "string" } } });
    if (!values.label) fail("--label is required");
    const days = values.days ? Number(values.days) : undefined;
    if (days !== undefined && (!Number.isInteger(days) || days <= 0)) fail("--days must be a positive whole number");
    const { key, record } = await issueKey(store, { label: values.label, expiresInDays: days });
    process.stdout.write(
      `Key id:   ${record.id}\nFor:      ${record.label}\nExpires:  ${record.expiresAt ?? "never"}\n\n` +
        `ACCESS KEY (shown once; only its hash is stored):\n\n    ${key}\n`,
    );
    return;
  }
  if (cmd === "list") {
    const keys = await listKeys(store);
    if (keys.length === 0) return void process.stdout.write("No keys issued.\n");
    for (const k of keys) {
      process.stdout.write(
        `${k.id}  ${k.status.padEnd(8)} uses=${String(k.uses).padEnd(4)} last=${(k.lastUsedAt ?? "never").slice(0, 16).padEnd(16)} expires=${(k.expiresAt ?? "never").slice(0, 10)}  ${k.label}\n`,
      );
    }
    return;
  }
  if (cmd === "revoke") {
    const id = rest[0];
    if (!id) fail("Pass the key id to revoke");
    const record = await revokeKey(store, id);
    if (!record) fail(`No such key: ${id}`);
    process.stdout.write(`Revoked ${record.id} (${record.label}). It stops working immediately.\n`);
    return;
  }
  fail("Unknown command");
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

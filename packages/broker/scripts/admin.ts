import { parseArgs } from "node:util";
import { createCode, recordKey, CODE_INDEX_KEY, type CodeRecord } from "../src/codes.js";
import { UpstashStore } from "../src/store.js";

const USAGE = `Usage:
  npm run issue-code -- --label "<operator>" --client <external_user_id>:<Display Name> [--client ...] [--broker <url>]
  npm run list-codes
  npm run revoke-code -- <code-id>

Needs KV_REST_API_URL + KV_REST_API_TOKEN (and BROKER_PUBLIC_URL for issue) in the environment.`;

function fail(msg: string): never {
  process.stderr.write(`${msg}\n\n${USAGE}\n`);
  process.exit(1);
}

async function issue(store: UpstashStore, argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      label: { type: "string" },
      client: { type: "string", multiple: true },
      broker: { type: "string" },
    },
  });
  const brokerUrl = values.broker ?? process.env.BROKER_PUBLIC_URL;
  if (!values.label) fail("--label is required");
  if (!brokerUrl) fail("Set BROKER_PUBLIC_URL or pass --broker");
  if (!values.client?.length) fail("At least one --client id:Name is required");

  const clients = values.client.map((raw) => {
    const i = raw.indexOf(":");
    if (i <= 0 || i === raw.length - 1) fail(`Bad --client "${raw}", expected id:Display Name`);
    return { id: raw.slice(0, i), name: raw.slice(i + 1) };
  });

  const { code, record } = await createCode(store, { label: values.label, clients, brokerUrl });
  process.stdout.write(`Code id:   ${record.id}\nOperator:  ${record.label}\nClients:   ${clients.map((c) => `${c.name} (${c.id})`).join(", ")}\n\n`);
  process.stdout.write(`Setup code (shown once, store it safely; only its hash is kept):\n${code}\n`);
}

async function list(store: UpstashStore): Promise<void> {
  const ids = await store.smembers(CODE_INDEX_KEY);
  if (ids.length === 0) return void process.stdout.write("No codes issued.\n");
  for (const id of ids) {
    const r = await store.get<CodeRecord>(recordKey(id));
    if (!r) continue;
    process.stdout.write(
      `${r.id}  ${r.status.padEnd(9)} ${r.label}  clients=[${r.clients.map((c) => c.id).join(",")}] selected=[${r.selected.join(",")}]\n`,
    );
  }
}

async function revoke(store: UpstashStore, id: string | undefined): Promise<void> {
  if (!id) fail("Pass the code id to revoke");
  const r = await store.get<CodeRecord>(recordKey(id));
  if (!r) fail(`No such code: ${id}`);
  await store.set(recordKey(id), { ...r, status: "revoked" });
  process.stdout.write(`Revoked ${id} (${r.label}). Its install tokens stop working immediately.\n`);
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const store = new UpstashStore();
  if (cmd === "issue") return issue(store, rest);
  if (cmd === "list") return list(store);
  if (cmd === "revoke") return revoke(store, rest[0]);
  fail("Unknown command");
}

main().catch((err: unknown) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});

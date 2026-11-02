import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readCredentials, readLocalConfig } from "../credentials.js";
import { decodeSetupCode } from "./code.js";
import { BrokerClient, BrokerHttpError } from "./broker-client.js";
import { brokerController, localController, vaultController } from "./controllers.js";
import { loadPipedreamEnv } from "./env-file.js";
import { startLocalServer } from "./local-server.js";
import { LocalSession } from "./local-session.js";
import { VaultSession } from "./vault-session.js";
import { fetchCredentials } from "./vault-source.js";
import { removeStaleBlock } from "./temp-env.js";
import { listClients } from "./pipedream-api.js";
import { SetupSession, UserError } from "./session.js";
import { AuthManager } from "../auth.js";

const TIMEOUT_MS = 30 * 60 * 1000;

const HELP = `MAVIS Pipedream setup

  npm run setup                          Install: a browser page asks for the access key your admin gave
                                         you, lists the clients, and installs the ones you pick
  npm run setup -- --local               Development: use the Pipedream client ID/secret already in
                                         env.local (or your environment), no access key
  npm run setup -- --code <setup code>   Broker install (first install, or new clients)

Options:
  --local          Development install (see above)
  --env-file <p>   With --local: read PIPEDREAM_* from this file instead of env.local
  --broker <url>   Override the broker URL embedded in the setup code (staging)
  --no-open        Print the setup link instead of opening a browser
  --no-register    Do not run \`claude mcp add\`; print the commands instead
`;

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => process.stdout.write(`Could not open a browser. Open this link yourself:\n${url}\n`));
  child.unref();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      code: { type: "string" },
      local: { type: "boolean" },
      "env-file": { type: "string" },
      broker: { type: "string" },
      "no-open": { type: "boolean" },
      "no-register": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help) return void process.stdout.write(HELP);

  const entryPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "index.js");

  if (values.local) {
    const repoRoot = resolve(dirname(entryPath), "..", "..", "..");
    const env = loadPipedreamEnv({ envFile: values["env-file"], searchDir: repoRoot });
    process.stdout.write(`Using Pipedream credentials from ${env.source} (project ${env.projectId}, ${env.environment}).\n`);

    let clients;
    try {
      clients = await listClients(
        new AuthManager(env.clientId, env.clientSecret),
        env.projectId,
        env.environment,
        fetch,
        (n) => process.stdout.write(`Reading clients from Pipedream… ${n} accounts\n`),
      );
    } catch (err) {
      throw new UserError(`Could not reach Pipedream with those credentials: ${err instanceof Error ? err.message : String(err)}`);
    }
    process.stdout.write(`Found ${clients.length} client${clients.length === 1 ? "" : "s"} with connected apps.\n`);

    const session = new LocalSession({
      env,
      clients,
      existing: readLocalConfig(),
      entryPath,
      registerWithClaude: !values["no-register"],
    });
    return runBrowser(startLocalServer(localController(session)), values["no-open"] === true, async () => {
      const state = await session.state();
      for (const r of state.results ?? []) {
        process.stdout.write(r.ok ? `Registered ${r.name} with Claude Code.\n` : `Register ${r.name} by running:\n  ${r.manualCommand}\n`);
      }
    });
  }

  const existing = readCredentials();
  let brokerUrl: string;
  let secret: string | undefined;

  if (values.code) {
    const decoded = decodeSetupCode(values.code);
    if (!decoded) throw new UserError("That setup code is not valid. Copy it again exactly as your admin sent it.");
    secret = decoded.secret;
    brokerUrl = values.broker ?? decoded.broker;
  } else if (existing?.sealed) {
    brokerUrl = values.broker ?? existing.broker;
  } else {
    return runVault(entryPath, values["no-open"] === true, !values["no-register"]);
  }

  const session = await SetupSession.start({
    broker: new BrokerClient(brokerUrl),
    brokerUrl,
    secret,
    existing,
    entryPath,
    registerWithClaude: !values["no-register"],
  });

  return runBrowser(startLocalServer(brokerController(session)), values["no-open"] === true, async () => {
    const state = await session.state();
    for (const r of state.results ?? []) {
      process.stdout.write(r.ok ? `Registered ${r.name} with Claude Code.\n` : `Register ${r.name} by running:\n  ${r.manualCommand}\n`);
    }
  });
}

/** Default flow: the access key is exchanged for the credentials with the vault server. */
async function runVault(entryPath: string, noOpen: boolean, registerWithClaude: boolean): Promise<void> {
  const pkgRoot = resolve(dirname(entryPath), "..");
  let vaultUrl = process.env.MAVIS_VAULT_URL;
  if (!vaultUrl) {
    const configPath = resolve(pkgRoot, "config", "vault.json");
    if (!existsSync(configPath)) throw new UserError("This copy has no access server configured (config/vault.json). Ask your admin for an updated copy.");
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as { url?: unknown };
    if (typeof cfg.url !== "string") throw new UserError("config/vault.json is damaged. Ask your admin for an updated copy.");
    vaultUrl = cfg.url;
  }
  const url = vaultUrl;

  const envPath = process.env.MAVIS_ENV_FILE ?? resolve(pkgRoot, "..", "..", "env.local");
  if (removeStaleBlock(envPath)) process.stdout.write("Removed temporary credentials left in env.local by an earlier run.\n");

  const session = new VaultSession({
    fetchCredentials: (key) => fetchCredentials(url, key),
    envPath,
    existing: readLocalConfig(),
    entryPath,
    registerWithClaude,
  });

  // The credentials sit in env.local only while setup runs. Remove them however setup ends.
  process.on("exit", () => session.dispose());
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => {
      session.dispose();
      process.exit(130);
    });
  }

  return runBrowser(
    startLocalServer(vaultController(session)),
    noOpen,
    async () => {
      const state = await session.state();
      for (const r of state.results ?? []) {
        process.stdout.write(r.ok ? `Registered ${r.name} with Claude Code.\n` : `Register ${r.name} by running:\n  ${r.manualCommand}\n`);
      }
    },
    {
      fallback: session.fallbackDone,
      finalMessage: "Setup complete.\n" + 'Start a new Claude Code session and ask: "What are the Pipedream integrations ready?"\n',
    },
  );
}

/** Opens the browser, waits for the page to finish, then reports and exits. */
async function runBrowser(
  pending: ReturnType<typeof startLocalServer>,
  noOpen: boolean,
  report: () => Promise<void>,
  opts: { fallback?: Promise<void>; finalMessage?: string } = {},
): Promise<void> {
  const server = await pending;
  if (noOpen) {
    process.stdout.write(`Open this link in your browser to continue setup:\n${server.url}\n`);
  } else {
    openBrowser(server.url);
    process.stdout.write("A browser window opened for you to finish setup.\n");
  }
  process.stdout.write(
    "Waiting for you to complete the steps in the browser. If an AI assistant is running this, it should wait and not try to answer for you.\n",
  );

  const timer = setTimeout(() => {
    process.stderr.write("Setup timed out after 30 minutes. Run it again to continue.\n");
    process.exit(1);
  }, TIMEOUT_MS);

  await Promise.race([server.finished, opts.fallback ?? new Promise<never>(() => {})]);
  clearTimeout(timer);
  await new Promise((r) => setTimeout(r, 2500)); // let the page read the final response and try to close itself
  server.close();

  await report();
  process.stdout.write(opts.finalMessage ?? "Setup complete. Restart Claude Code to load the new connections.\n");
  process.exit(0);
}

main().catch((err: unknown) => {
  const msg = err instanceof UserError || err instanceof BrokerHttpError ? err.message : err instanceof Error ? err.message : String(err);
  process.stderr.write(`Setup failed: ${msg}\n`);
  process.exit(1);
});

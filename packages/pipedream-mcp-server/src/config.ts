import { AuthManager } from "./auth.js";
import { BrokerAuthManager } from "./broker-auth.js";
import { readCredentials, readLocalConfig, updateClientToken } from "./credentials.js";
import { Config } from "./types.js";

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * Two modes:
 *  --client <slug>  Broker mode (operators). Reads the install token from ~/.mavis-pipedream; no Pipedream secret needed.
 *  --user <id>      Direct mode (dev/admin). Uses PIPEDREAM_CLIENT_ID/SECRET/PROJECT_ID from the environment,
 *                   or the local.json written by `setup --local`.
 */
export async function loadConfig(): Promise<Config> {
  const args = process.argv.slice(2);
  const slug = argValue(args, "--client");
  const user = argValue(args, "--user");

  if (slug) return loadBrokerConfig(slug);
  if (user) return loadDirectConfig(user);
  throw new Error("Missing required --client <slug> (installed via setup) or --user <external_user_id> (direct mode)");
}

async function loadBrokerConfig(slug: string): Promise<Config> {
  const creds = readCredentials();
  if (!creds) throw new Error("Not set up on this machine. Run `npm run setup` with the setup code from your admin.");
  const client = creds.clients.find((c) => c.slug === slug);
  if (!client) {
    const known = creds.clients.map((c) => c.slug).join(", ") || "none";
    throw new Error(`Unknown client "${slug}". Installed clients: ${known}`);
  }

  const auth = new BrokerAuthManager(creds.broker, client.token, (t) => updateClientToken(slug, t));
  const session = await auth.getSession();
  return {
    auth,
    projectId: session.projectId,
    environment: session.environment,
    externalUserId: session.externalUserId,
  };
}

/** Environment variables win; otherwise use the credentials saved by `setup --local`. */
function loadDirectConfig(externalUserId: string): Config {
  const local = readLocalConfig();
  const required = {
    PIPEDREAM_CLIENT_ID: process.env.PIPEDREAM_CLIENT_ID ?? local?.clientId,
    PIPEDREAM_CLIENT_SECRET: process.env.PIPEDREAM_CLIENT_SECRET ?? local?.clientSecret,
    PIPEDREAM_PROJECT_ID: process.env.PIPEDREAM_PROJECT_ID ?? local?.projectId,
  };

  const missing = Object.entries(required)
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length > 0) {
    throw new Error(
      `Missing Pipedream credentials (${missing.join(", ")}). Set them in the environment or run \`npm run setup -- --local\`.`,
    );
  }

  return {
    auth: new AuthManager(required.PIPEDREAM_CLIENT_ID!, required.PIPEDREAM_CLIENT_SECRET!),
    projectId: required.PIPEDREAM_PROJECT_ID!,
    environment: process.env.PIPEDREAM_PROJECT_ENVIRONMENT ?? local?.environment ?? "production",
    externalUserId,
  };
}

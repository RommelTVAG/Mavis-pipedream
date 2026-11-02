# Mavis-pipedream

Pipedream MCP proxy for Claude Code. A CSA installs it once on their PC with an **access key** from their admin, picks the clients they work with in a browser, and the app installs one MCP connection per client.

## Install (for CSAs)

Your admin gives you an **access key** (`XXXXX-XXXXX-XXXXX-XXXXX-XXXXX`). Open Claude Code and paste:

> Clone https://github.com/RommelTVAG/Mavis-pipedream, cd into it, and run `npm run bootstrap`. Don't type anything into the browser for me. Tell me when the browser opens and wait for me.

The key is **not** part of that prompt. You type it in the browser, so it never lands in your Claude Code chat history.

1. A browser window opens and asks for the access key. Enter it.
2. The app checks your key with the access server, then reads the clients from Pipedream (it shows progress; a large project takes about 20 seconds).
3. Each client is labelled with the name of the accounts they connected, usually a Gmail address, plus apps, account count and last update. Some people appear under several client IDs; those rows say "Same name as N other clients", so check the short ID. Search by name, email, ID or app, tick one or more, and click **Install**.
4. The app installs an MCP server per client and saves what the MCP needs to connect (`~/.mavis-pipedream/local.json`, readable only by you).
5. Close the browser tab. Start a new Claude Code session and ask: **"What are the Pipedream integrations ready?"** The final page also shows this as a copyable `claude "…"` command.

Browsers only let a page close tabs it opened, so the tab may stay open. Close it yourself.

If setup is interrupted (Ctrl-C, closed terminal), just run `npm run setup` again. Run it again later to add a client too.

Flags: `--no-register` prints the `claude mcp add` commands instead of running them, `--no-open` prints the link instead of opening a browser.

## Admin: the access server

The Pipedream credentials live **only on a server we run** (the VPS), never in this repo. A CSA's access key is exchanged for them over HTTPS. The repo is public and contains no secrets: `packages/pipedream-mcp-server/config/vault.json` holds only the server's address.

```
CSA machine ──key──► https://pipedream-access.thevagroup.com ──► nginx (Cloudflare only) ──► vault (localhost:4021)
```

What protects it:
- Keys are per CSA, 125 random bits, stored only as a hash, with an optional expiry. You can revoke one instantly. A revoked, expired, unknown or malformed key all get the same answer.
- Attempts are throttled per address, and every issue and refusal is logged (who, never the key or the secret).
- The service runs as its own no-login user in a systemd sandbox, listens on localhost only, and exposes just two routes (`/api/credentials`, `/api/health`).
- nginx only accepts Cloudflare's address ranges, so the client address used for throttling cannot be faked.

### Day to day (run from your machine; keys are shown only in your terminal)

```bash
ssh mavis "mavis-vault-admin issue --label 'Pat CSA' --days 90"   # prints the key once; give it to the CSA
ssh mavis "mavis-vault-admin list"                                 # who has keys, last use, expiry
ssh mavis "mavis-vault-admin revoke <key-id>"                      # stops working immediately
```

Put the whole command inside double quotes, as above: `ssh` hands it to a shell on the server, which would otherwise choke on spaces or parentheses in the label. Run these yourself rather than through an assistant, so keys never end up in a chat or a log. Keys are shown once and not stored.

### Deploying changes

```bash
VAULT_SSH_HOST=mavis ./packages/broker/deploy/deploy.sh   # test, build, upload, restart, health check
```

### One-time server setup (already done on the `mavis` VPS)

1. A no-login user `mavis-vault`; code in `/opt/mavis-vault`; state in `/var/lib/mavis-vault/state` (0700); secrets in `/etc/mavis-vault/vault.env` (root:mavis-vault, 0640) with `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_PROJECT_ENVIRONMENT`, `BROKER_SIGNING_KEY`, `BROKER_PUBLIC_URL`, `HOST`, `PORT`, `VAULT_STATE_DIR`, `ROUTES` (see `packages/broker/.env.example`).
2. `packages/broker/deploy/mavis-vault.service` into `/etc/systemd/system/`, then `systemctl enable --now mavis-vault`.
3. `packages/broker/deploy/nginx-site.conf` as the site for the hostname, with Cloudflare's ranges filled in. Run `nginx -t` before reloading.
4. A proxied Cloudflare DNS record for the hostname pointing at the VPS.

### Rotating the Pipedream secret

If a CSA leaves or a key may have leaked, revoking their key stops future fetches, but a CSA who already installed keeps the credentials on their machine. To cut that off, create a new client secret in Pipedream, update `/etc/mavis-vault/vault.env`, and `systemctl restart mavis-vault`. Existing installs stop working until their owners run `npm run setup` again.

### What to know

- The secret still ends up on every CSA's machine (`~/.mavis-pipedream/local.json`, readable only by that user), because the MCP needs it to run. A server cannot change that. The broker flow below keeps it off their machines.
- The VPS now holds the secret. Keep SSH keys tight and the machine patched. State on disk holds only key hashes; losing it means reissuing keys.

## Other install modes

### Development install (no key)

Uses the credentials already in `env.local` and skips the key page. For the admin's own testing:

```bash
npm run bootstrap -- --local     # first time
npm run setup -- --local         # afterwards
```

Use `--env-file <path>` to read a different file. The client lock described below does not apply here.

### Broker flow (per-person revocation)

The broker keeps the Pipedream secret off CSA machines entirely and supports a per-operator setup code and a client lock. It needs `packages/broker` deployed on Vercel.

#### For operators

Your admin sends you a **setup code** (`mavis_…`). Paste this into Claude Code:

> Clone https://github.com/RommelTVAG/Mavis-pipedream, cd into it, and run `npm run bootstrap -- --code <your setup code>`. Don't answer any prompts for me. Tell me when the browser opens and wait for me.

Then, in the browser window that opens:

1. Tick the clients you work with (several is fine).
2. For each client, type an app name (for example `slack`, `gmail`) and sign in on the Pipedream page. Repeat per app.
3. Type `LOCK` and finish. **This is permanent**: the install can only ever reach those clients.

Restart Claude Code, then ask: *"List my available integrations."* Each client appears as its own MCP server, `pipedream-<client>`.

- **Connect more apps later** for the same clients: `npm run setup` (no code needed).
- **Add a new client**: your admin sends a new setup code; run `npm run setup -- --code <new code>`.
- The human must complete the browser steps. An AI assistant running the command should wait.

What is stored on your machine: `~/.mavis-pipedream/credentials.json` (mode 600) holding one install token per client. No Pipedream ID or secret.

#### For admins (broker)

##### Deploy the broker (Vercel)

1. Create a Vercel project from this repo with **Root Directory** `packages/broker`.
2. Add a KV store (Upstash Redis via the Vercel Marketplace). It sets `KV_REST_API_URL` / `KV_REST_API_TOKEN`.
3. Set env vars (see `packages/broker/.env.example`): `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, `PIPEDREAM_PROJECT_ID`, `PIPEDREAM_PROJECT_ENVIRONMENT`, `BROKER_SIGNING_KEY` (`openssl rand -base64 48`), `BROKER_PUBLIC_URL`.
4. Point a **stable custom domain** at it (for example `broker.thevagroup.com`) and use that as `BROKER_PUBLIC_URL`. The domain is embedded in every setup code, so moving to a VPS later is a DNS change only.
5. Check `GET /api/health`.

##### Issue, list and revoke setup codes

Run locally with the KV variables in your environment:

```bash
cd packages/broker && npm install
npm run issue-code -- --label "Pat (operator)" \
  --client cust_123:"Acme Corp" --client cust_456:"Beta LLC"
npm run list-codes
npm run revoke-code -- <code-id>
```

`--client` takes `<Pipedream external_user_id>:<Display name>`. The code is shown once; only its hash is stored. Revoking a code stops that operator's access immediately. Rotating `BROKER_SIGNING_KEY` revokes every install.

##### How the lock works

Enforced on the broker, not in the CLI. A setup code carries a fixed client allowlist. The operator's selection is recorded when they pick it and sealed when they finish. After sealing, the code cannot enroll or select again, and every install token is bound to one client: the broker takes the `external_user_id` from the signed token, never from the request.

##### Known limitation

The broker hands out a Pipedream project access token (about 1 hour). It is project-wide while valid, so it is stronger than a permanent secret on disk but not scoped per client. Fully scoped access would need the broker to proxy Pipedream calls itself.

##### Local development

```bash
cd packages/broker && npm run dev        # in-memory broker + mock Pipedream on :8787, prints a setup code
cd packages/pipedream-mcp-server && npm run build
node dist/setup/cli.js --code <printed code> --no-register
```

Tests: `npm test` in `packages/broker` and in `packages/pipedream-mcp-server`.

##### Direct mode (admin and debugging only)

The proxy can still run without the broker, using the Pipedream secret from the environment:

```bash
PIPEDREAM_CLIENT_ID=… PIPEDREAM_CLIENT_SECRET=… PIPEDREAM_PROJECT_ID=… \
  node packages/pipedream-mcp-server/dist/index.js --user <external_user_id>
```

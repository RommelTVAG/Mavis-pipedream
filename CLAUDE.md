# MAVIS Pipedream - Claude Code Project Guide

## Project Overview

A Pipedream MCP proxy for Claude Code. For one client's `external_user_id` it auto-discovers all of that client's connected Pipedream apps and exposes them as tools through a single MCP connection. Operators install it with a browser-based setup; the Pipedream client ID and secret live only in a hosted **broker**, never on operator machines. See `README.md` for the operator and admin guides.

## Layout

- `packages/pipedream-mcp-server/` — the stdio MCP proxy plus the setup CLI
- `packages/broker/` — Vercel functions that hold the Pipedream secret, issue setup codes and mint tokens
- `scripts/bootstrap.mjs` — `npm run bootstrap -- --code <setup code>`: install, build, run setup

## Install with an access key (default, `npm run setup`)

The repo is **public and holds no credentials**. The Pipedream client ID and secret live on the VPS (`ssh mavis`; service `mavis-vault`, code in `packages/broker`, `src/server.ts`). `config/vault.json` holds only the server's URL. Install for a CSA with `npm run bootstrap`: the browser page asks for the access key, which the human types and which never goes through the prompt, the terminal or any file. The app POSTs the key to `/api/credentials`, puts the returned credentials into a **temporary block in `env.local`** (`# >>> MAVIS TEMPORARY`), lists the clients, installs the picked ones (`~/.mavis-pipedream/local.json` 0600 + `claude mcp add` with `--user <external_id>`), and the final page removes the block and shows the next step (`claude "What are the Pipedream integrations ready?"`). The block is also removed on exit/SIGINT/SIGTERM, by a 60 s fallback after install, and at the next start if a run was killed. Setup refuses to touch an `env.local` that already holds Pipedream credentials. Do not type the key for the user and never print it, the secret, or `env.local`/`local.json` contents. Keys are issued with `ssh mavis "mavis-vault-admin issue --label 'Who' --days N"` (whole command in double quotes, labels without parentheses; run by the admin in their own terminal, never by an assistant in a shared transcript). Code: `src/setup/vault-source.ts`, `vault-session.ts`, `temp-env.ts`; server: `packages/broker/src/vault.ts`, `routes.ts` (credentials), `store.ts` (FileStore), `deploy/`.

## Development install (`--local`, no key)

`npm run bootstrap -- --local` (or `npm run setup -- --local`) reads `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, `PIPEDREAM_PROJECT_ID` from `env.local` (git-ignored) or the environment, lists the project's clients (external user IDs) in a browser page, and on **Install** writes `~/.mavis-pipedream/local.json` (0600) and registers `pipedream-<slug>` with `--user <external_id>`. Do not choose clients for the user: the page is theirs to drive. Never print the secret or the contents of `env.local` or `local.json`. In this mode `src/config.ts` direct mode falls back to `local.json` when the env vars are absent.

## Installing for an operator (when the user pastes a setup code)

Run `npm run bootstrap -- --code <setup code>` from the repo root, then tell the user a browser window opened and **wait**. Do not try to answer for them: choosing clients and typing `LOCK` (which permanently limits the install) must be done by the human in the browser. Never print install tokens or the setup code back. When setup exits, tell them to restart Claude Code.

If `claude mcp add` could not run automatically, setup prints the exact command per client; run those.

## MCP Proxy

Modes (`src/config.ts`):

- `--client <slug>` — broker mode (operators). Reads the install token from `~/.mavis-pipedream/credentials.json` and gets short-lived Pipedream access tokens from the broker. No Pipedream secret needed.
- `--user <external_user_id>` — direct mode (admin/debug). Needs `PIPEDREAM_CLIENT_ID`, `PIPEDREAM_CLIENT_SECRET`, `PIPEDREAM_PROJECT_ID` in the environment.

Flow: resolve auth → List Accounts API to discover apps → connect to each app's MCP endpoint in parallel → register all tools under one connection (`list_integrations` meta-tool included). Each client is a separate MCP server named `pipedream-<slug>`.

Accounts: every healthy account is pinned with `x-pd-account-id` (`app-client.ts`), one connection per account. An app with one account keeps the tool names `<slug>-<tool>`; an app with several (e.g. three Outlook mailboxes) gets `<slug>-<account>-<tool>`, where `<account>` is the account name's part before `@` (`accountKeys` in `tool-registry.ts`, account id if empty or shared). Without the header Pipedream silently picks one account, so never remove it. `list_integrations` shows each account's `tool_prefix`.

### Verifying it works

In a new Claude Code session, ask: *List my available integrations.* The agent should call `list_integrations` and return the apps connected in Pipedream. Apps Pipedream marks unhealthy are skipped until reconnected.

## Security rules for changes here

- The Pipedream client secret lives only on the VPS (`/etc/mavis-vault/vault.env`, root:mavis-vault 0640). On a CSA machine it is only in `local.json` (0600) and, briefly, the temporary `env.local` block. Never put it in the repo (public), `.mcp.json`, the Claude Code config, logs, or any HTTP response or page state. Never log a key or a secret; refusals must stay identical for unknown, revoked, expired and malformed keys.
- The broker takes `external_user_id` from the signed install token, never from a request body. Keep it that way.
- The client lock is enforced server-side (`finalize` seals the record). Do not move that check into the CLI.
- The setup UI binds to `127.0.0.1`, pins the Host header, requires a single-use nonce/cookie and Origin checks on POST, and sets a strict CSP (no inline `style=` attributes: CSP blocks them).
- Give every HTML element in the setup UI a unique `id` (prefix `mvs-`).

## Tests

`npm test` in `packages/broker` and in `packages/pipedream-mcp-server` (both use `tsx --test`). The broker's `npm run dev` gives an in-memory broker with a mock Pipedream for end-to-end runs; never deploy it.

## Key Files

Proxy (`packages/pipedream-mcp-server/src/`):

- `index.ts` — entry point, orchestrates startup
- `config.ts` — chooses broker or direct mode
- `broker-auth.ts` — token provider backed by the broker (cache, refresh, install-token renewal)
- `auth.ts` — direct OAuth token manager
- `credentials.ts` — `~/.mavis-pipedream/credentials.json` (dir 0700, file 0600)
- `discovery.ts`, `app-client.ts`, `tool-registry.ts`, `proxy-server.ts` — discovery, per-app MCP clients, tool routing, stdio server
- `setup/` — setup CLI: `cli.ts`; broker flow `session.ts`, `ui.ts`, `broker-client.ts`; key flow `vault-session.ts`, `vault-source.ts`, `temp-env.ts`; local flow `local-session.ts`, `ui-local.ts` (shared by key and local flows), `env-file.ts`, `pipedream-api.ts`; shared `local-server.ts` (loopback server driven by a `Controller` from `controllers.ts`), `merge.ts`, `register.ts`

Broker (`packages/broker/`):

- `api/*.ts` — thin Vercel adapters
- `src/routes.ts` — enroll, select, finalize, connect-token, accounts, access-token, health
- `src/http.ts` — auth helpers, rate limiting, error handling
- `src/tokens.ts`, `src/codes.ts` — HMAC install tokens, setup codes
- `src/pipedream.ts` — the only code that uses the Pipedream secret
- `src/vault.ts`, `src/server.ts`, `scripts/vault-admin.ts`, `deploy/` — the VPS credentials vault: key issue/revoke, standalone server, admin CLI, systemd unit, nginx site, deploy script
- `scripts/admin.ts` — issue / list / revoke setup codes

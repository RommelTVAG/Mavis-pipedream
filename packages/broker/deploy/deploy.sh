#!/bin/sh
# Build, test and deploy the credentials vault to the VPS, then restart it.
#   VAULT_SSH_HOST=<your ssh alias> ./deploy/deploy.sh
# One-time server setup (user, directories, secrets file, systemd unit, nginx site, DNS) is in the README.
set -eu
HOST="${VAULT_SSH_HOST:?set VAULT_SSH_HOST to the ssh alias or user@host of the VPS}"
cd "$(dirname "$0")/.."

npm ci --no-audit --no-fund
npm test
rm -rf dist
npm run build

rsync -a --delete --exclude node_modules dist package.json package-lock.json "$HOST:/opt/mavis-vault/"
ssh "$HOST" 'set -e
  chown -R root:root /opt/mavis-vault/dist
  cd /opt/mavis-vault && npm ci --omit=dev --ignore-scripts --no-audit --no-fund
  systemctl restart mavis-vault
  sleep 2
  echo "vault: $(systemctl is-active mavis-vault)"
  curl -fs http://127.0.0.1:4021/api/health && echo'

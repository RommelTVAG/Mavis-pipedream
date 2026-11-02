#!/usr/bin/env node
// One command for a fresh clone: install + build the MCP server, then run browser setup.
//   npm run bootstrap -- --code <setup code>
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "packages", "pipedream-mcp-server");
const win = process.platform === "win32";

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { cwd: pkgDir, stdio: "inherit", shell: opts.shell ?? false });
  if (res.error) {
    console.error(`Could not run ${cmd}: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) process.exit(res.status ?? 1);
}

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`Node 20 or newer is required (found ${process.versions.node}).`);
  process.exit(1);
}

console.log("Installing dependencies…");
run("npm", ["install", "--no-audit", "--no-fund"], { shell: win });
console.log("Building…");
run("npm", ["run", "build"], { shell: win });
run("node", ["dist/setup/cli.js", ...process.argv.slice(2)]);

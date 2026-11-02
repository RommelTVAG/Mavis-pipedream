/**
 * Standalone production server for the VPS. Listens on localhost only; nginx terminates TLS in front.
 * Exposes only the routes named in ROUTES (default: credentials and health), so the rest of the
 * broker API is not reachable even though the code is present.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { parseEnv } from "./env.js";
import { dispatch, type Deps } from "./http.js";
import { createLogger } from "./logger.js";
import { PipedreamClient } from "./pipedream.js";
import { routePaths, routes, type RouteName } from "./routes.js";
import { FileStore } from "./store.js";

const MAX_BODY = 16 * 1024;

function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function main(): void {
  const env = parseEnv();
  const log = createLogger(env.LOG_LEVEL);
  const host = process.env.HOST ?? "127.0.0.1";
  const port = Number(process.env.PORT ?? 4021);
  const stateDir = process.env.VAULT_STATE_DIR ?? "/var/lib/mavis-vault/state";
  const enabled = new Set((process.env.ROUTES ?? "credentials,health").split(",").map((s) => s.trim()));

  const deps: Deps = { env, store: new FileStore(stateDir), pipedream: new PipedreamClient(env), log, now: Date.now };
  const byPath = new Map<string, RouteName>();
  for (const name of Object.keys(routes) as RouteName[]) {
    if (enabled.has(routes[name].name)) byPath.set(routePaths[name], name);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      const name = byPath.get(url.pathname);
      if (!name) {
        res.writeHead(404, { "Content-Type": "application/json" }).end('{"error":"not_found"}');
        return;
      }
      let body: string | undefined;
      if (req.method !== "GET" && req.method !== "HEAD") {
        const text = await readBody(req);
        if (text === null) {
          res.writeHead(413, { "Content-Type": "application/json" }).end('{"error":"too_large"}');
          return;
        }
        body = text;
      }
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const out = await dispatch(routes[name], new Request(url, { method: req.method, headers, body }), deps);
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(await out.text());
    } catch (err) {
      log.error({ err }, "request failed");
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "application/json" });
      res.end('{"error":"internal_error"}');
    }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  server.listen(port, host, () => log.info({ host, port, routes: [...byPath.keys()] }, "vault listening"));
  const stop = (): void => {
    log.info("shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();

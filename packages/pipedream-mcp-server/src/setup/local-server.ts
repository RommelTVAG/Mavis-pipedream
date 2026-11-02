import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { AddressInfo } from "node:net";
import { BrokerHttpError } from "./broker-client.js";
import { UserError } from "./session.js";
import { renderCallbackPage } from "./ui.js";

/** What the loopback server serves and which actions the page may trigger. */
export interface Controller {
  renderPage(nonce: string): string;
  state(): Promise<unknown>;
  /** POST /api/<name>. Each returns the JSON response body. */
  actions: Record<string, (body: Record<string, unknown>, ctx: { port: number }) => Promise<unknown>>;
  /** Name of the action whose success ends the session (its response should carry the final state). */
  finishAction: string;
}

export interface LocalServer {
  /** URL to open in the browser. Contains a single-use nonce. */
  url: string;
  port: number;
  /** Resolves when the session reaches "done" and the final response has been delivered. */
  finished: Promise<void>;
  close(): void;
}

const MAX_BODY = 64 * 1024;

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new UserError("Request too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

/**
 * Loopback-only server for the setup UI. Defences: bound to 127.0.0.1, Host header pinned (DNS
 * rebinding), single-use URL nonce exchanged for an HttpOnly cookie, Origin check on POSTs, strict CSP.
 */
export async function startLocalServer(controller: Controller): Promise<LocalServer> {
  const entryNonce = randomBytes(24).toString("base64url");
  const sessionId = randomBytes(24).toString("base64url");
  let entryUsed = false;
  let port = 0;
  let finishResolve!: () => void;
  const finished = new Promise<void>((r) => (finishResolve = r));

  const authed = (req: IncomingMessage): boolean => {
    const c = cookieValue(req, "mvs");
    return c !== undefined && safeEqual(c, sessionId);
  };

  const send = (res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", ...headers });
    res.end(body);
  };
  const sendJson = (res: ServerResponse, status: number, data: unknown): void =>
    send(res, status, JSON.stringify(data), { "Content-Type": "application/json" });

  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 403, "Forbidden");
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);

    if (req.method === "GET" && url.pathname === "/callback") {
      const nonce = randomBytes(12).toString("base64url");
      return send(res, 200, renderCallbackPage(nonce), { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": `default-src 'none'; style-src 'nonce-${nonce}'` });
    }

    if (req.method === "GET" && url.pathname === "/") {
      const s = url.searchParams.get("s");
      if (s !== null) {
        if (!entryUsed && safeEqual(s, entryNonce)) {
          entryUsed = true;
          return send(res, 302, "", { Location: "/", "Set-Cookie": `mvs=${sessionId}; HttpOnly; SameSite=Lax; Path=/` });
        }
        return send(res, 403, "This setup link was already used. Re-run setup for a new one.");
      }
      if (!authed(req)) return send(res, 403, "Open the setup link that was opened for you by the setup command.");
      const nonce = randomBytes(16).toString("base64url");
      return send(res, 200, controller.renderPage(nonce), {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      });
    }

    if (!url.pathname.startsWith("/api/") || !authed(req)) return send(res, 404, "Not found");

    try {
      if (req.method === "GET" && url.pathname === "/api/state") return sendJson(res, 200, await controller.state());
      if (req.method !== "POST") return send(res, 405, "Method not allowed");
      if (req.headers.origin !== `http://127.0.0.1:${port}`) return send(res, 403, "Forbidden");

      const raw = await readBody(req);
      const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;

      const name = url.pathname.slice("/api/".length);
      const action = Object.hasOwn(controller.actions, name) ? controller.actions[name] : undefined;
      if (!action) return send(res, 404, "Not found");
      const result = await action(body, { port });
      if (name === controller.finishAction) res.on("finish", () => finishResolve());
      return sendJson(res, 200, result);
    } catch (err) {
      if (err instanceof UserError || err instanceof BrokerHttpError) {
        return sendJson(res, err instanceof BrokerHttpError && err.status >= 500 ? 502 : 400, { message: err.message });
      }
      if (err instanceof SyntaxError) return sendJson(res, 400, { message: "Bad request" });
      process.stderr.write(`setup: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
      return sendJson(res, 500, { message: "Something went wrong. Check the terminal." });
    }
  };

  const server: Server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, "Error");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}/?s=${entryNonce}`,
    port,
    finished,
    close: () => server.close(),
  };
}

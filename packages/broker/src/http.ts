import type { Env } from "./env.js";
import type { Logger } from "./logger.js";
import type { Store } from "./store.js";
import type { PipedreamClient } from "./pipedream.js";
import { findBySecret, recordKey, type CodeRecord } from "./codes.js";
import { verifyToken, type InstallClaims } from "./tokens.js";

export interface Deps {
  env: Env;
  store: Store;
  pipedream: PipedreamClient;
  log: Logger;
  now: () => number;
}

export interface Ctx {
  req: Request;
  deps: Deps;
  /** Set once an install token is authenticated; used for logging and rate limiting. */
  cid?: string;
}

export type Handler = (ctx: Ctx) => Promise<Response>;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(h);
  return m?.[1] ?? null;
}

/** Everything after "Bearer ", spaces included. For keys people may paste with spaces. */
export function bearerRemainder(req: Request): string | null {
  const h = req.headers.get("authorization");
  const m = h ? /^Bearer\s+(.+)$/i.exec(h) : null;
  return m?.[1]?.trim() || null;
}

export async function readJson(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > 16 * 1024) throw new HttpError(413, "too_large", "Request body too large");
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, "invalid_json", "Body must be valid JSON");
  }
}

/** Authenticate with the one-time setup-code secret (enroll / select / finalize). */
export async function requireSetupCode(ctx: Ctx): Promise<CodeRecord> {
  const secret = bearer(ctx.req);
  if (!secret) throw new HttpError(401, "unauthorized", "Missing setup code");
  const record = await findBySecret(ctx.deps.store, secret);
  if (!record || record.status === "revoked") throw new HttpError(401, "unauthorized", "Invalid setup code");
  ctx.cid = record.id;
  return record;
}

/**
 * Authenticate an install token. Besides the signature, the code record must still be live and the
 * token's client must be in the operator's selection. This is what enforces the lock server-side.
 */
export async function requireInstall(ctx: Ctx): Promise<{ claims: InstallClaims; record: CodeRecord }> {
  const token = bearer(ctx.req);
  if (!token) throw new HttpError(401, "unauthorized", "Missing install token");
  const claims = verifyToken(token, ctx.deps.env.BROKER_SIGNING_KEY, ctx.deps.now());
  if (!claims) throw new HttpError(401, "unauthorized", "Invalid or expired install token");

  const record = await ctx.deps.store.get<CodeRecord>(recordKey(claims.cid));
  if (!record || record.status === "revoked") throw new HttpError(401, "unauthorized", "Install revoked");
  if (!record.selected.includes(claims.uid)) throw new HttpError(403, "client_not_selected", "Client is not part of this install");
  ctx.cid = record.id;
  return { claims, record };
}

/**
 * The caller's address. X-Real-IP is overwritten by our reverse proxy (nginx sets it from
 * CF-Connecting-IP), so unlike X-Forwarded-For the caller cannot choose it.
 */
export function clientIp(req: Request): string {
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real;
  const fwd = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return fwd || "unknown";
}

export interface RouteConfig {
  name: string;
  method: "GET" | "POST";
  /** Max requests per minute per IP. */
  limit: number;
  handler: Handler;
}

/** Wraps a route with method check, rate limiting, structured logging and sanitized errors. */
export async function dispatch(route: RouteConfig, req: Request, deps: Deps): Promise<Response> {
  const started = deps.now();
  const ctx: Ctx = { req, deps };
  let res: Response;
  try {
    if (req.method !== route.method) throw new HttpError(405, "method_not_allowed", `Use ${route.method}`);

    const bucket = Math.floor(started / 60_000);
    const count = await deps.store.incr(`rl:${route.name}:${clientIp(req)}:${bucket}`, 70);
    if (count > route.limit) throw new HttpError(429, "rate_limited", "Too many requests, try again shortly");

    res = await route.handler(ctx);
  } catch (err) {
    if (err instanceof HttpError) {
      res = json(err.status, { error: err.code, message: err.message });
    } else {
      deps.log.error({ err, route: route.name }, "unhandled error");
      res = json(500, { error: "internal_error", message: "Something went wrong" });
    }
  }
  deps.log.info({ route: route.name, status: res.status, cid: ctx.cid, ms: deps.now() - started }, "request");
  return res;
}

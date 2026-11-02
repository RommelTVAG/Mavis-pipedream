import { z } from "zod";
import { CLIENT_ID_PATTERN, recordKey, type CodeRecord } from "./codes.js";
import { bearerRemainder, clientIp, HttpError, json, readJson, requireInstall, requireSetupCode, type RouteConfig } from "./http.js";
import { findKey, recordUse } from "./vault.js";
import { PipedreamError } from "./pipedream.js";
import { newClaims, RENEW_WHEN_REMAINING_SECONDS, signToken } from "./tokens.js";

/** Only the operator's own loopback callback is allowed as a Pipedream redirect target. */
const REDIRECT_PATTERN = /^http:\/\/127\.0\.0\.1:\d{1,5}\/callback$/;
const APP_SLUG_PATTERN = /^[a-z0-9_]{1,64}$/;

const selectBody = z.object({
  clientIds: z.array(z.string().regex(CLIENT_ID_PATTERN)).min(1).max(50),
});

const connectBody = z.object({
  redirectUri: z.string().regex(REDIRECT_PATTERN).optional(),
  app: z.string().regex(APP_SLUG_PATTERN).optional(),
});

async function parse<T>(schema: z.ZodType<T>, req: Request): Promise<T> {
  const result = schema.safeParse(await readJson(req));
  if (!result.success) {
    throw new HttpError(400, "invalid_request", result.error.issues.map((i) => i.path.join(".") || "body").join(", "));
  }
  return result.data;
}

/** Pipedream failures are logged server-side; callers get a generic upstream error. */
async function upstream<T>(ctxLog: (e: unknown) => void, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof PipedreamError) {
      ctxLog(err);
      throw new HttpError(502, "upstream_error", "Pipedream request failed");
    }
    throw err;
  }
}

const enroll: RouteConfig = {
  name: "enroll",
  method: "POST",
  limit: 20,
  handler: async (ctx) => {
    const record = await requireSetupCode(ctx);
    if (record.status === "finalized") {
      throw new HttpError(409, "sealed", "This install is already sealed. Ask your admin for a new setup code to add clients.");
    }
    return json(200, { label: record.label, clients: record.clients, selected: record.selected });
  },
};

const select: RouteConfig = {
  name: "select",
  method: "POST",
  limit: 20,
  handler: async (ctx) => {
    const record = await requireSetupCode(ctx);
    if (record.status !== "open") throw new HttpError(409, "sealed", "Selection is locked");
    const { clientIds } = await parse(selectBody, ctx.req);

    const unique = [...new Set(clientIds)];
    const allowed = new Map(record.clients.map((c) => [c.id, c.name]));
    const unknown = unique.filter((id) => !allowed.has(id));
    if (unknown.length > 0) throw new HttpError(400, "unknown_client", "One or more clients are not on this code's list");

    const updated: CodeRecord = { ...record, selected: unique };
    await ctx.deps.store.set(recordKey(record.id), updated);

    const key = ctx.deps.env.BROKER_SIGNING_KEY;
    const clients = unique.map((id) => ({
      id,
      name: allowed.get(id) as string,
      token: signToken(newClaims(record.id, id, ctx.deps.now()), key),
    }));
    return json(200, { clients });
  },
};

const finalize: RouteConfig = {
  name: "finalize",
  method: "POST",
  limit: 20,
  handler: async (ctx) => {
    const record = await requireSetupCode(ctx);
    if (record.status !== "open") throw new HttpError(409, "sealed", "Already sealed");
    if (record.selected.length === 0) throw new HttpError(400, "nothing_selected", "Select at least one client first");
    const updated: CodeRecord = { ...record, status: "finalized", finalizedAt: new Date(ctx.deps.now()).toISOString() };
    await ctx.deps.store.set(recordKey(record.id), updated);
    return json(200, { sealed: true, clients: record.selected });
  },
};

const connectToken: RouteConfig = {
  name: "connect-token",
  method: "POST",
  limit: 30,
  handler: async (ctx) => {
    const { claims } = await requireInstall(ctx);
    const { redirectUri, app } = await parse(connectBody, ctx.req);
    // external_user_id always comes from the signed token, never from the request.
    const result = await upstream(
      (e) => ctx.deps.log.error({ err: e, cid: claims.cid }, "connect token failed"),
      () => ctx.deps.pipedream.createConnectToken(claims.uid, redirectUri),
    );

    const link = new URL(result.connectLinkUrl);
    if (link.protocol !== "https:" || !/(^|\.)pipedream\.com$/.test(link.hostname)) {
      ctx.deps.log.error({ host: link.hostname }, "unexpected connect link host");
      throw new HttpError(502, "upstream_error", "Pipedream request failed");
    }
    if (app) link.searchParams.set("app", app);
    return json(200, { connectLinkUrl: link.toString(), expiresAt: result.expiresAt });
  },
};

const accounts: RouteConfig = {
  name: "accounts",
  method: "POST",
  limit: 60,
  handler: async (ctx) => {
    const { claims } = await requireInstall(ctx);
    const list = await upstream(
      (e) => ctx.deps.log.error({ err: e, cid: claims.cid }, "list accounts failed"),
      () => ctx.deps.pipedream.listAccounts(claims.uid),
    );
    return json(200, { accounts: list });
  },
};

const accessToken: RouteConfig = {
  name: "access-token",
  method: "POST",
  limit: 120,
  handler: async (ctx) => {
    const { claims, record } = await requireInstall(ctx);
    const t = await upstream(
      (e) => ctx.deps.log.error({ err: e, cid: claims.cid }, "access token failed"),
      () => ctx.deps.pipedream.getAccessToken(),
    );

    const remaining = claims.exp - Math.floor(ctx.deps.now() / 1000);
    const renewedToken =
      remaining < RENEW_WHEN_REMAINING_SECONDS
        ? signToken(newClaims(claims.cid, claims.uid, ctx.deps.now()), ctx.deps.env.BROKER_SIGNING_KEY)
        : undefined;

    return json(200, {
      accessToken: t.accessToken,
      expiresIn: t.expiresIn,
      projectId: ctx.deps.pipedream.projectId,
      environment: ctx.deps.pipedream.environment,
      externalUserId: claims.uid,
      clientName: record.clients.find((c) => c.id === claims.uid)?.name ?? claims.uid,
      renewedToken,
    });
  },
};

/** Attempts per IP per 15 minutes on the credentials route, on top of the per-minute limit. */
const CREDENTIAL_ATTEMPTS = 30;

/**
 * Vault: a valid per-CSA key gets the Pipedream credentials. Every failure looks the same to the
 * caller (and costs the same), so a response never says whether a key exists, expired or was revoked.
 */
const credentials: RouteConfig = {
  name: "credentials",
  method: "POST",
  limit: 20,
  handler: async (ctx) => {
    const ip = clientIp(ctx.req);
    const attempts = await ctx.deps.store.incr(`attempts:credentials:${ip}`, 900);
    if (attempts > CREDENTIAL_ATTEMPTS) throw new HttpError(429, "rate_limited", "Too many attempts, try again later");

    const presented = bearerRemainder(ctx.req);
    const found = presented ? await findKey(ctx.deps.store, presented, ctx.deps.now()) : null;
    if (!found || !found.ok) {
      ctx.deps.log.warn({ ip, reason: found ? found.reason : "missing" }, "credentials request refused");
      throw new HttpError(401, "unauthorized", "That key didn't work");
    }

    ctx.cid = found.record.id;
    await recordUse(ctx.deps.store, found.record, ctx.deps.now());
    ctx.deps.log.info({ ip, keyId: found.record.id, label: found.record.label }, "credentials issued");
    const { env } = ctx.deps;
    return json(200, {
      clientId: env.PIPEDREAM_CLIENT_ID,
      clientSecret: env.PIPEDREAM_CLIENT_SECRET,
      projectId: env.PIPEDREAM_PROJECT_ID,
      environment: env.PIPEDREAM_PROJECT_ENVIRONMENT,
    });
  },
};

const health: RouteConfig = {
  name: "health",
  method: "GET",
  limit: 120,
  handler: async () => json(200, { ok: true }),
};

export const routes = { enroll, select, finalize, connectToken, accounts, accessToken, credentials, health } as const;
export type RouteName = keyof typeof routes;
export const routePaths: Record<RouteName, string> = {
  enroll: "/api/enroll",
  select: "/api/select",
  finalize: "/api/finalize",
  connectToken: "/api/connect-token",
  accounts: "/api/accounts",
  accessToken: "/api/access-token",
  credentials: "/api/credentials",
  health: "/api/health",
};

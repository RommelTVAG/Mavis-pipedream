import { createHmac, timingSafeEqual } from "node:crypto";

/** Install token claims. `cid` is the setup-code record id, `uid` the Pipedream external_user_id. */
export interface InstallClaims {
  v: 1;
  cid: string;
  uid: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export const TOKEN_TTL_SECONDS = 90 * 24 * 3600;
export const RENEW_WHEN_REMAINING_SECONDS = 30 * 24 * 3600;

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function mac(payload: string, key: string): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

export function signToken(claims: InstallClaims, key: string): string {
  const payload = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  return `${payload}.${b64url(mac(payload, key))}`;
}

export function verifyToken(token: string, key: string, nowMs: number = Date.now()): InstallClaims | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts as [string, string];

  const expected = mac(payload, key);
  const given = Buffer.from(sig, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let claims: unknown;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isClaims(claims)) return null;
  if (claims.exp * 1000 <= nowMs) return null;
  return claims;
}

function isClaims(v: unknown): v is InstallClaims {
  if (typeof v !== "object" || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    c.v === 1 &&
    typeof c.cid === "string" &&
    typeof c.uid === "string" &&
    typeof c.exp === "number" &&
    Number.isFinite(c.exp)
  );
}

export function newClaims(cid: string, uid: string, nowMs: number = Date.now()): InstallClaims {
  return { v: 1, cid, uid, exp: Math.floor(nowMs / 1000) + TOKEN_TTL_SECONDS };
}

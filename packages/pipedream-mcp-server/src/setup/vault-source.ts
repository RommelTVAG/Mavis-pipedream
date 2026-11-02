import { assertSafeBrokerUrl } from "../credentials.js";
import { UserError } from "./session.js";

/** Credentials the vault server hands to a valid access key. */
export interface VaultPayload {
  clientId: string;
  clientSecret: string;
  projectId: string;
  environment: string;
}

const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Same rules as the server: forgives case, spaces, dashes and the look-alike letters I, L, O. */
export function normalizeKey(input: string): string | null {
  const k = input.toUpperCase().replace(/[\s-]/g, "").replace(/[IL]/g, "1").replace(/O/g, "0");
  return k.length === 25 && [...k].every((c) => ALPHABET.includes(c)) ? k : null;
}

/**
 * Asks the vault server for the Pipedream credentials. Error messages are fixed text: they never
 * include the key or anything the server returned.
 */
export async function fetchCredentials(vaultUrl: string, key: string, fetchImpl: typeof fetch = fetch): Promise<VaultPayload> {
  const normalized = normalizeKey(key.trim());
  if (!normalized) throw new UserError("That key doesn't look right. Check it and try again.");
  // Send the canonical XXXXX-XXXXX-... form: spaces typed by the user would break the HTTP header.
  const canonical = (normalized.match(/.{5}/g) as string[]).join("-");
  const base = assertSafeBrokerUrl(vaultUrl);

  let res: Response;
  try {
    res = await fetchImpl(new URL("/api/credentials", base), {
      method: "POST",
      headers: { Authorization: `Bearer ${canonical}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new UserError("Can't reach the access server. Check your connection and try again.");
  }
  if (res.status === 401) throw new UserError("That key didn't work. Check it and try again.");
  if (res.status === 429) throw new UserError("Too many attempts. Wait a few minutes and try again.");
  if (!res.ok) throw new UserError(`The access server had a problem (${res.status}). Try again later.`);

  const data = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  const ok =
    data !== null &&
    [data.clientId, data.clientSecret, data.projectId].every((v) => typeof v === "string" && v.length > 0) &&
    (data.environment === "production" || data.environment === "development");
  if (!ok) throw new UserError("The access server sent an unexpected answer. Try again later.");
  return data as unknown as VaultPayload;
}

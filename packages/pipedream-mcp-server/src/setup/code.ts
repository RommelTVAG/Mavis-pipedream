/** Setup-code decoding. Format: `mavis_` + base64url(JSON {v:1, b:<broker url>, s:<secret>}). Mirrors the broker's encoder. */
export function decodeSetupCode(code: string): { broker: string; secret: string } | null {
  const trimmed = code.trim();
  if (!trimmed.startsWith("mavis_")) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(trimmed.slice("mavis_".length), "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const p = parsed as Record<string, unknown>;
    if (p.v !== 1 || typeof p.b !== "string" || typeof p.s !== "string" || !p.s) return null;
    return { broker: p.b, secret: p.s };
  } catch {
    return null;
  }
}

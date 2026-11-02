import { z } from "zod";

const envSchema = z.object({
  PIPEDREAM_CLIENT_ID: z.string().min(1),
  PIPEDREAM_CLIENT_SECRET: z.string().min(1),
  PIPEDREAM_PROJECT_ID: z.string().min(1),
  PIPEDREAM_PROJECT_ENVIRONMENT: z.enum(["production", "development"]).default("production"),
  PIPEDREAM_API_BASE: z.string().url().default("https://api.pipedream.com/v1"),
  BROKER_SIGNING_KEY: z.string().min(32, "BROKER_SIGNING_KEY must be at least 32 characters"),
  BROKER_PUBLIC_URL: z.string().url(),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

type Source = Record<string, string | undefined>;

export function parseEnv(source: Source = process.env): Env {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid broker environment: ${issues}`);
  }
  return result.data;
}

/** Upstash / Vercel KV accept either variable naming. */
export function parseStoreEnv(source: Source = process.env): { url: string; token: string } {
  const url = source.KV_REST_API_URL ?? source.UPSTASH_REDIS_REST_URL;
  const token = source.KV_REST_API_TOKEN ?? source.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) {
    throw new Error(
      "Missing KV credentials: set KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)",
    );
  }
  return { url, token };
}

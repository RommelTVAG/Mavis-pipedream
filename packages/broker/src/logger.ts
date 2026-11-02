import pino from "pino";

export type Logger = pino.Logger;

export function createLogger(level: string = process.env.LOG_LEVEL ?? "info"): Logger {
  return pino({
    level,
    base: { svc: "pipedream-broker" },
    redact: {
      paths: ["req.headers.authorization", "authorization", "token", "accessToken", "secret", "code"],
      censor: "[redacted]",
    },
  });
}

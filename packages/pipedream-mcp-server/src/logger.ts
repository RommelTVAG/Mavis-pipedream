type LogLevel = "INFO" | "WARN" | "ERROR" | "DEBUG";

function log(level: LogLevel, message: string, data?: Record<string, unknown>) {
  const timestamp = new Date().toISOString();
  const parts = [`[${timestamp}] [${level}] ${message}`];
  if (data) {
    parts.push(JSON.stringify(data));
  }
  process.stderr.write(parts.join(" ") + "\n");
}

export const logger = {
  info: (msg: string, data?: Record<string, unknown>) => log("INFO", msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => log("WARN", msg, data),
  error: (msg: string, data?: Record<string, unknown>) => log("ERROR", msg, data),
  debug: (msg: string, data?: Record<string, unknown>) => log("DEBUG", msg, data),
};

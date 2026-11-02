import { loadConfig } from "./config.js";
import { discoverApps } from "./discovery.js";
import { ToolRegistry } from "./tool-registry.js";
import { startServer } from "./proxy-server.js";
import { logger } from "./logger.js";

async function main() {
  try {
    // 1. Load configuration
    const config = await loadConfig();
    logger.info(`Starting proxy for user ${config.externalUserId}`);

    // 2. Auth is resolved by loadConfig (broker token or direct OAuth)
    const auth = config.auth;

    // 3. Discover connected apps
    const apps = await discoverApps(
      auth,
      config.projectId,
      config.environment,
      config.externalUserId,
    );

    if (apps.size === 0) {
      logger.warn("No connected apps found for this user");
    }

    // 4. Build tool registry (connects to each app's MCP endpoint)
    const registry = new ToolRegistry(
      auth,
      config.projectId,
      config.environment,
      config.externalUserId,
    );
    await registry.initialize(apps);

    // 5. Start the stdio MCP server
    await startServer(registry);

    // Cleanup on exit
    process.on("SIGINT", async () => {
      logger.info("Shutting down");
      await registry.close();
      process.exit(0);
    });

    process.on("SIGTERM", async () => {
      logger.info("Shutting down");
      await registry.close();
      process.exit(0);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`Fatal: ${message}`);
    process.exit(1);
  }
}

main();

import { parseEnv } from "./env.js";
import { createLogger } from "./logger.js";
import { PipedreamClient } from "./pipedream.js";
import { UpstashStore } from "./store.js";
import { dispatch, type Deps } from "./http.js";
import { routes, type RouteName } from "./routes.js";

let cached: Deps | null = null;

/** Built lazily on first request so env errors surface as a logged 500, not an import crash. */
function productionDeps(): Deps {
  if (!cached) {
    const env = parseEnv();
    cached = {
      env,
      store: new UpstashStore(),
      pipedream: new PipedreamClient(env),
      log: createLogger(env.LOG_LEVEL),
      now: Date.now,
    };
  }
  return cached;
}

export async function handle(name: RouteName, req: Request): Promise<Response> {
  let deps: Deps;
  try {
    deps = productionDeps();
  } catch (err) {
    createLogger().error({ err }, "broker misconfigured");
    return new Response(JSON.stringify({ error: "internal_error", message: "Something went wrong" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
  return dispatch(routes[name], req, deps);
}

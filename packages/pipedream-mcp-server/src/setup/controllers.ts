import type { Controller } from "./local-server.js";
import type { LocalSession } from "./local-session.js";
import type { VaultSession } from "./vault-session.js";
import { UserError, type SetupSession } from "./session.js";
import { renderPage } from "./ui.js";
import { renderLocalPage } from "./ui-local.js";

function ids(body: Record<string, unknown>): string[] {
  const v = body.clientIds;
  if (!Array.isArray(v) || !v.every((i) => typeof i === "string")) throw new UserError("Pick at least one client.");
  return v;
}

/** Broker flow: choose clients, connect apps, lock. */
export function brokerController(session: SetupSession): Controller {
  return {
    renderPage,
    state: () => session.state(),
    finishAction: "finish",
    actions: {
      select: async (body) => {
        await session.select(ids(body));
        return { ok: true };
      },
      connect: async (body, { port }) => {
        if (typeof body.clientId !== "string" || typeof body.app !== "string") throw new UserError("Missing client or app.");
        return { url: await session.connect(body.clientId, body.app, `http://127.0.0.1:${port}/callback`) };
      },
      finish: async (body) => {
        await session.finish(typeof body.confirm === "string" ? body.confirm : "");
        // The CLI exits right after this response, so it carries the final state.
        return session.state();
      },
    },
  };
}

/** Local (development) flow: choose clients, install. */
export function localController(session: LocalSession): Controller {
  return {
    renderPage: renderLocalPage,
    state: () => session.state(),
    finishAction: "install",
    actions: {
      install: (body) => session.install(ids(body)),
    },
  };
}

/** Key page → pick clients → install → final page removes the temporary credentials. */
export function vaultController(session: VaultSession): Controller {
  return {
    renderPage: renderLocalPage,
    state: () => session.state(),
    finishAction: "cleanup",
    actions: {
      unlock: async (body) => {
        if (typeof body.key !== "string") throw new UserError("Enter your key.");
        await session.unlock(body.key);
        return { ok: true };
      },
      install: (body) => session.install(ids(body)),
      cleanup: () => session.cleanup(),
    },
  };
}

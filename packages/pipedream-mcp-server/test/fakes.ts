import type { BrokerClient, ConnectedApp, IssuedClient } from "../src/setup/broker-client.js";
import { BrokerHttpError } from "../src/setup/broker-client.js";

export const ALLOWED = [
  { id: "cust_a", name: "Acme Corp" },
  { id: "cust_b", name: "Beta LLC" },
  { id: "cust_c", name: "Gamma Inc" },
];

/** In-memory stand-in for the broker client, recording call order. */
export class FakeBroker {
  log: string[] = [];
  sealed = false;
  failFinalize = false;
  apps = new Map<string, ConnectedApp[]>();

  async enroll(secret: string) {
    this.log.push("enroll");
    if (secret === "bad") throw new BrokerHttpError(401, "unauthorized", "Invalid setup code");
    if (this.sealed) throw new BrokerHttpError(409, "sealed", "sealed");
    return { label: "Pat Operator", clients: ALLOWED, selected: [] };
  }
  async select(_secret: string, ids: string[]): Promise<IssuedClient[]> {
    this.log.push(`select:${ids.join(",")}`);
    return ids.map((id) => {
      const c = ALLOWED.find((a) => a.id === id);
      if (!c) throw new BrokerHttpError(400, "unknown_client", "unknown");
      return { ...c, token: `tok_${id}` };
    });
  }
  async finalize() {
    this.log.push("finalize");
    if (this.failFinalize) throw new BrokerHttpError(500, "internal_error", "boom");
    this.sealed = true;
    return { sealed: true };
  }
  async connectToken(token: string, opts: { redirectUri: string; app: string }) {
    this.log.push(`connect:${token}:${opts.app}`);
    return `https://pipedream.com/connect?app=${opts.app}&t=${token}`;
  }
  async accounts(token: string) {
    return this.apps.get(token) ?? [];
  }
}

export const asClient = (b: FakeBroker): BrokerClient => b as unknown as BrokerClient;

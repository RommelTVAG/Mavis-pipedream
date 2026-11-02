import { handle } from "../src/runtime.js";

export const GET = (req: Request): Promise<Response> => handle("health", req);

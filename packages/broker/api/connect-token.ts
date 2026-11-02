import { handle } from "../src/runtime.js";

export const POST = (req: Request): Promise<Response> => handle("connectToken", req);

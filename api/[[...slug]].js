// Vercel serverless entrypoint. Vercel mounts every request under /api/* here.
// We delegate to the same Hono app used by the Node server.
import { handle } from "hono/vercel";
import { buildApp } from "../src/app.js";

export const config = { runtime: "nodejs" };

const app = buildApp();
export default handle(app);

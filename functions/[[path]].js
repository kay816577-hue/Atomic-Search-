// Cloudflare Pages Functions catch-all. Delegates every non-static request
// (everything under /api/* and /proxy) to the same Hono app.
import { buildApp } from "../src/app.js";

const app = buildApp();

export const onRequest = (context) => app.fetch(context.request, context.env, context);

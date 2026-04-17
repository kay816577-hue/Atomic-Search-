// Node entrypoint — used by Render, Railway, Fly, Docker, bare VPS.
// Also starts the private crawler when SQLite is available.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildApp } from "./src/app.js";
import { startCrawler } from "./src/crawler.js";

const app = buildApp();

// Serve static frontend. Matches any path not already handled by /api or /proxy.
app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

const port = Number(process.env.PORT) || 3000;
serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  // Intentionally minimal — no request logging (privacy).
  console.log(`Atomic Search listening on http://localhost:${info.port}`);
});

startCrawler(5000);

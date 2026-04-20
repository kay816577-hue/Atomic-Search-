// Node entrypoint — used by Render, Railway, Fly, Docker, bare VPS.
// Boots the Hono app, starts the private crawler when SQLite is available,
// and wires up the GitHub-branch-based index snapshot/restore so the crawl
// index survives Render free-tier restarts with zero external storage.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildApp } from "./src/app.js";
import { startCrawler } from "./src/crawler.js";
import { startIndexSync } from "./src/git_sync.js";

const app = buildApp();

// Static frontend. `serveStatic` handles everything under ./public; anything
// else falls through to index.html so client-side routing keeps working.
app.use("/*", serveStatic({ root: "./public" }));
app.get("*", serveStatic({ path: "./public/index.html" }));

const port = Number(process.env.PORT) || 3000;

// Restore the SQLite index from the data branch (if configured) BEFORE the
// crawler starts writing to it.
startIndexSync()
  .catch((err) => console.error("index-sync init failed:", err?.message || err))
  .finally(() => {
    startCrawler(5000);
  });

serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
  // Intentionally minimal — no request logging (privacy).
  console.log(`Atomic Search listening on http://localhost:${info.port}`);
});

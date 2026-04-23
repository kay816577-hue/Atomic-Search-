// Node entrypoint — used by Render, Railway, Fly, Docker, bare VPS.
// Boots the Hono app, starts the private crawler when SQLite is available,
// and wires up the GitHub-branch-based index snapshot/restore so the crawl
// index survives Render free-tier restarts with zero external storage.

import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { buildApp } from "./src/app.js";
import { startCrawler } from "./src/crawler.js";
import { startIndexSync } from "./src/git_sync.js";

const port = Number(process.env.PORT) || 3000;

// IMPORTANT: We must restore the SQLite snapshot from the data branch BEFORE
// any request (or the crawler) is allowed to touch the DB. If a request
// opens better-sqlite3 on an empty DATA_DIR during restore, the subsequent
// copy would either race with WAL writes or — worse — we'd push an empty
// DB back up to the data branch on the next tick and wipe the remote
// snapshot too. Hence we await the restore phase before starting the HTTP
// server.
async function main() {
  await startIndexSync().catch((err) =>
    console.error("index-sync init failed:", err?.message || err)
  );

  const app = buildApp();

  // Static frontend. `serveStatic` handles everything under ./public;
  // anything else falls through to index.html so client-side routing keeps
  // working.
  app.use("/*", serveStatic({ root: "./public" }));
  app.get("*", serveStatic({ path: "./public/index.html" }));

  serve({ fetch: app.fetch, port, hostname: "0.0.0.0" }, (info) => {
    // Intentionally minimal — no request logging (privacy).
    console.log(`Atomic Search listening on http://localhost:${info.port}`);
  });

  // Crawler runs after the restore completes, so the first page it writes
  // lands alongside the restored snapshot instead of on top of an empty DB.
  startCrawler(5000);
}

main().catch((err) => {
  console.error("atomic-search boot failed:", err?.message || err);
  process.exit(1);
});

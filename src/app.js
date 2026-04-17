// Unified Hono application — the same app file is mounted by the Node,
// Vercel and Cloudflare Pages adapters. Kept intentionally tiny. All routes
// are stateless and never log user-identifying information.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { metaSearch } from "./aggregator.js";
import { metaImages } from "./images.js";
import { aiAnswer } from "./ai.js";
import { proxyHandler } from "./proxy.js";
import {
  cacheGet,
  cacheSet,
  searchPages,
  addSubmission,
  stats as storageStats,
} from "./storage.js";
import { isSafeUrl } from "./safeurl.js";

const SEARCH_TTL = 15 * 60 * 1000; // 15 min — good enough, not long enough to stale
const IMAGE_TTL = 30 * 60 * 1000;

function privacyHeaders() {
  return {
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "interest-cohort=(), browsing-topics=()",
    "Cache-Control": "no-store",
  };
}

export function buildApp() {
  const app = new Hono();

  app.use("*", cors({ origin: "*", allowHeaders: ["Content-Type"] }));
  app.use("*", async (c, next) => {
    await next();
    for (const [k, v] of Object.entries(privacyHeaders())) c.res.headers.set(k, v);
  });

  app.get("/api/health", (c) => c.json({ ok: true, time: Date.now() }));

  app.get("/api/stats", async (c) => c.json(await storageStats()));

  app.get("/api/search", async (c) => {
    const q = (c.req.query("q") || "").trim();
    if (!q) return c.json({ query: "", results: [], engines: {} });
    const key = `search:${q.toLowerCase()}`;
    const cached = await cacheGet(key);
    if (cached) return c.json({ ...cached, cached: true });
    const own = await searchPages(q, 5).catch(() => []);
    const result = await metaSearch(q);
    // Merge our own index results — they go on top when exact title matches.
    if (own.length) {
      const ownFormatted = own.map((p) => ({
        url: p.url,
        host: p.host,
        title: p.title,
        snippet: (p.text || "").slice(0, 240),
        engines: ["atomic"],
        score: 2,
      }));
      const seen = new Set(ownFormatted.map((x) => x.url));
      result.results = [
        ...ownFormatted,
        ...result.results.filter((x) => !seen.has(x.url)),
      ];
    }
    await cacheSet(key, result, SEARCH_TTL);
    return c.json(result);
  });

  app.get("/api/images", async (c) => {
    const q = (c.req.query("q") || "").trim();
    if (!q) return c.json({ query: "", results: [] });
    const key = `images:${q.toLowerCase()}`;
    const cached = await cacheGet(key);
    if (cached) return c.json({ ...cached, cached: true });
    const data = await metaImages(q);
    await cacheSet(key, data, IMAGE_TTL);
    return c.json(data);
  });

  app.post("/api/ai", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const q = (body.q || c.req.query("q") || "").trim();
    if (!q) return c.json({ query: "", answer: "", sources: [] });
    const search = await metaSearch(q);
    const answer = await aiAnswer(q, search.results);
    return c.json(answer);
  });

  app.post("/api/submit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = (body.url || "").trim();
    if (!isSafeUrl(url)) return c.json({ ok: false, error: "Invalid URL" }, 400);
    await addSubmission(url);
    return c.json({ ok: true });
  });

  app.get("/api/music/search", async (c) => {
    const q = (c.req.query("q") || "").trim();
    if (!q) return c.json({ tracks: [] });
    // Audius is an open, royalty-free music network. No API key needed.
    const host = "https://discoveryprovider.audius.co";
    const r = await fetch(`${host}/v1/tracks/search?query=${encodeURIComponent(q)}&app_name=AtomicSearch`).catch(() => null);
    if (!r || !r.ok) return c.json({ tracks: [] });
    const data = await r.json().catch(() => ({}));
    const tracks = (data.data || []).slice(0, 30).map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.user?.name || t.user?.handle || "Unknown",
      duration: t.duration,
      artwork: t.artwork?.["480x480"] || t.artwork?.["150x150"] || null,
      streamUrl: `${host}/v1/tracks/${t.id}/stream?app_name=AtomicSearch`,
      permalink: t.permalink ? `https://audius.co${t.permalink}` : null,
    }));
    return c.json({ tracks });
  });

  app.get("/api/music/trending", async (c) => {
    const host = "https://discoveryprovider.audius.co";
    const r = await fetch(`${host}/v1/tracks/trending?app_name=AtomicSearch`).catch(() => null);
    if (!r || !r.ok) return c.json({ tracks: [] });
    const data = await r.json().catch(() => ({}));
    const tracks = (data.data || []).slice(0, 30).map((t) => ({
      id: t.id,
      title: t.title,
      artist: t.user?.name || t.user?.handle || "Unknown",
      duration: t.duration,
      artwork: t.artwork?.["480x480"] || t.artwork?.["150x150"] || null,
      streamUrl: `${host}/v1/tracks/${t.id}/stream?app_name=AtomicSearch`,
    }));
    return c.json({ tracks });
  });

  app.get("/proxy", async (c) => {
    const url = c.req.query("url");
    return proxyHandler(url);
  });

  return app;
}

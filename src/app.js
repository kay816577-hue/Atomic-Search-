// Unified Hono application — the same app file is mounted by the Node,
// Vercel and Cloudflare Pages adapters. Kept intentionally tiny. All routes
// are stateless and never log user-identifying information.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { metaSearch } from "./aggregator.js";
import { metaImages } from "./images.js";
import { aiAnswer } from "./ai.js";
import { proxyHandler } from "./proxy.js";
import { safetyCheck } from "./safety.js";
import {
  cacheGet,
  cacheSet,
  searchPages,
  addSubmission,
  enqueueCrawl,
  stats as storageStats,
} from "./storage.js";
import { isSafeUrl } from "./safeurl.js";

const SEARCH_TTL = 15 * 60 * 1000; // 15 min per page — good enough, not stale
const IMAGE_TTL = 30 * 60 * 1000;

function privacyHeaders() {
  return {
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "interest-cohort=(), browsing-topics=()",
    "Cache-Control": "no-store",
  };
}

// Fire-and-forget: enqueue top result URLs for our own crawler so the index
// genuinely grows as people search. Capped per call so we never blow up the
// queue on a single hit.
function growIndex(results, cap = 12) {
  try {
    const picks = (results || []).slice(0, cap);
    for (const r of picks) {
      if (!r?.url) continue;
      if (!isSafeUrl(r.url)) continue;
      // SQLite queue is Node-only; on Workers this no-ops.
      enqueueCrawl(r.url).catch(() => {});
    }
  } catch { /* ignore */ }
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
    if (!q) return c.json({ query: "", results: [], engines: {}, page: 1, hasMore: false });
    const page = Math.max(1, Math.min(20, Number(c.req.query("page")) || 1));
    const perPage = Math.max(10, Math.min(200, Number(c.req.query("per_page")) || 100));
    const key = `search:${q.toLowerCase()}:p${page}:n${perPage}`;
    const cached = await cacheGet(key);
    if (cached) return c.json({ ...cached, cached: true });

    // Own-index matches — promoted only on page 1.
    const own = page === 1 ? await searchPages(q, 10).catch(() => []) : [];
    const result = await metaSearch(q, { page, perPage });
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
      ].slice(0, perPage);
    }
    await cacheSet(key, result, SEARCH_TTL);
    // Auto-grow our index from top meta-results.
    growIndex(result.results);
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
    // Reuse the page-1 search cache if present — avoids a second full fan-out.
    const cacheKey = `search:${q.toLowerCase()}:p1:n100`;
    const cached = await cacheGet(cacheKey);
    let results;
    if (cached?.results?.length) {
      results = cached.results;
    } else {
      const search = await metaSearch(q, { page: 1, perPage: 100 });
      await cacheSet(cacheKey, search, SEARCH_TTL);
      results = search.results;
    }
    const answer = await aiAnswer(q, results);
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

  // Safety check — returns a VT verdict for a URL. Called by the /go
  // interstitial and by any client that wants to risk-rate a link.
  app.get("/api/safety", async (c) => {
    const url = (c.req.query("url") || "").trim();
    if (!isSafeUrl(url)) return c.json({ verdict: "unknown", error: "invalid-url" });
    const cacheKey = `safetyapi:${url}`;
    const cached = await cacheGet(cacheKey);
    if (cached) return c.json({ url, ...cached, cached: true });
    const summary = await safetyCheck(url);
    await cacheSet(cacheKey, summary, 10 * 60 * 1000);
    return c.json({ url, ...summary });
  });

  // /go is a tiny interstitial page: looks up the URL safety verdict and
  // shows a "Continue anonymously" button that routes the click through our
  // /proxy. Works even if JS is disabled (the button is a plain anchor).
  app.get("/go", async (c) => {
    const target = (c.req.query("url") || "").trim();
    if (!isSafeUrl(target)) {
      return c.html(
        `<!doctype html><meta charset="utf-8"><title>Blocked</title>` +
          `<p>Blocked: target URL is not safe to load.</p>`,
        400
      );
    }
    let host = target;
    try { host = new URL(target).hostname.replace(/^www\./, ""); } catch { /* ignore */ }
    const summary = await safetyCheck(target);
    const verdict = summary.verdict || "unknown";
    const color = verdict === "clean" ? "#2ecc71"
      : verdict === "suspicious" ? "#f39c12"
      : verdict === "malicious" ? "#e74c3c"
      : "#7f8c8d";
    const blurb = verdict === "clean" ? `No security vendors flagged this URL.`
      : verdict === "suspicious" ? `${summary.suspicious || 0} vendor(s) flagged this URL as suspicious.`
      : verdict === "malicious" ? `${summary.malicious || 0} vendor(s) flagged this URL as malicious.`
      : verdict === "unscanned" ? `Safety scanning is not configured on this server.`
      : `This URL has not been analysed yet.`;
    const proxyUrl = `/proxy?url=${encodeURIComponent(target)}`;
    const directUrl = target.replace(/"/g, "&quot;");
    const escHost = host.replace(/</g, "&lt;");
    const escTarget = target.replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const cont = verdict === "malicious" ? "Continue anyway (not recommended)" : "Continue anonymously";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Safety check — Atomic Search</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<link rel="stylesheet" href="/css/styles.css">
<link rel="stylesheet" href="/css/themes.css">
</head><body data-theme="atom-dark" class="interstitial">
<main style="max-width:640px;margin:60px auto;padding:28px;">
  <h1 style="margin-top:0">Safety check</h1>
  <p style="color:var(--text-dim)">Before you leave Atomic, we checked this link with VirusTotal.</p>
  <div style="border:1px solid var(--border);border-radius:12px;padding:20px;margin:24px 0;background:var(--bg-elev-1);">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
      <span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:${color}"></span>
      <strong style="text-transform:capitalize">${verdict}</strong>
      <span style="color:var(--text-dim);font-size:13px;margin-left:auto">${escHost}</span>
    </div>
    <p style="margin:0 0 6px;">${blurb}</p>
    <p style="margin:0;color:var(--text-dim);font-size:13px;word-break:break-all">${escTarget}</p>
  </div>
  <div style="display:flex;gap:12px;flex-wrap:wrap">
    <a href="${proxyUrl}" style="background:var(--accent);color:#fff;padding:10px 18px;border-radius:999px;text-decoration:none;font-weight:600">${cont}</a>
    <a href="${directUrl}" rel="noreferrer noopener nofollow" style="background:var(--bg-elev-2);color:var(--text);padding:10px 18px;border-radius:999px;text-decoration:none;border:1px solid var(--border)">Open directly (leaks IP)</a>
    <a href="/" style="color:var(--text-dim);padding:10px 18px;text-decoration:none">Go back</a>
  </div>
  <p style="margin-top:24px;color:var(--text-dim);font-size:12px">No history is saved. Atomic never logs which links you click.</p>
</main>
</body></html>`;
    return c.html(html);
  });

  app.all("/proxy", async (c) => {
    const url = c.req.query("url") || "";
    return proxyHandler(url);
  });

  return app;
}

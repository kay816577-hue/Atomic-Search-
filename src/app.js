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
  getAnswer,
  putAnswer,
} from "./storage.js";
import { isSafeUrl } from "./safeurl.js";
import { buildAuthRoutes, currentUser } from "./auth.js";
import { scanDownload } from "./scan.js";
import { crawlOne } from "./crawler.js";

const SEARCH_TTL = 15 * 60 * 1000; // 15 min per page — good enough, not stale
const IMAGE_TTL = 30 * 60 * 1000;
const SAFETY_TTL = 60 * 60 * 1000; // 1h (under the 24h cache in safety.js)

function privacyHeaders() {
  return {
    "Referrer-Policy": "no-referrer",
    "X-Robots-Tag": "noindex, nofollow",
    "Permissions-Policy": "interest-cohort=(), browsing-topics=()",
    "Cache-Control": "no-store",
  };
}

// Fire-and-forget: eagerly crawl the top result URLs in parallel so the
// Atomic index grows on every search (instead of waiting 5s per tick), and
// enqueue the rest for the background crawler to pick up.
function growIndex(results, { eager = 5, queueCap = 20 } = {}) {
  try {
    const urls = (results || [])
      .map((r) => r?.url)
      .filter((u) => u && isSafeUrl(u));
    // Eager: crawl top N now, in parallel, each bounded by 5s.
    const head = urls.slice(0, eager);
    for (const u of head) {
      crawlOne(u, { timeoutMs: 5000 }).catch(() => {});
    }
    // Rest: queue for the background crawler.
    for (const u of urls.slice(eager, queueCap)) {
      enqueueCrawl(u).catch(() => {});
    }
  } catch { /* ignore */ }
}

// Fire-and-forget AI synthesis so repeat searches for the same query surface
// a pinned "Atomic answer" card. Runs after the response has been sent so
// the user never waits on it.
function rememberAnswer(query, results) {
  (async () => {
    try {
      const existing = await getAnswer(query);
      if (existing) return; // already cached
      const ai = await aiAnswer(query, results);
      if (ai?.answer) {
        await putAnswer(query, { answer: ai.answer, mode: ai.mode, sources: ai.sources });
      }
    } catch { /* ignore */ }
  })();
}

// Score an own-index row against the query so we can boost strong matches
// above meta-search results. Simple but effective:
// - +3 for every distinct query token found in title
// - +1 for every distinct query token found in text
// - +2 bonus if the whole phrase appears in title
// - small recency bonus
function scoreOwnIndexRow(row, query) {
  const q = (query || "").toLowerCase();
  const title = (row.title || "").toLowerCase();
  const text = (row.text || "").toLowerCase();
  const tokens = q.split(/\s+/).filter((t) => t.length >= 2);
  let score = 0;
  for (const t of tokens) {
    if (title.includes(t)) score += 3;
    if (text.includes(t)) score += 1;
  }
  if (q.length >= 4 && title.includes(q)) score += 2;
  const age = Math.max(0, Date.now() - (row.indexed_at || 0));
  if (age < 7 * 24 * 3600 * 1000) score += 0.5; // fresh
  return score;
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
    if (!q) return c.json({ query: "", results: [], page: 1, hasMore: false });
    const page = Math.max(1, Math.min(20, Number(c.req.query("page")) || 1));
    const perPage = Math.max(10, Math.min(200, Number(c.req.query("per_page")) || 50));
    const key = `search:${q.toLowerCase()}:p${page}:n${perPage}`;
    const cached = await cacheGet(key);
    if (cached) {
      // Even on cache hit, attach the latest cached answer (it may have been
      // synthesised after this search entry was stored).
      const atomicAnswer = page === 1 ? await getAnswer(q).catch(() => null) : null;
      return c.json({ ...cached, cached: true, atomicAnswer });
    }

    // Own-index matches — fetched on every page so strong in-index results
    // always surface underneath meta results.
    const ownRaw = await searchPages(q, 30).catch(() => []);
    const ownRanked = ownRaw
      .map((p) => ({
        url: p.url,
        host: p.host,
        title: p.title,
        text: p.text, // full body so AI synthesis has something meaty to chew on
        snippet: (p.text || "").slice(0, 240),
        engines: ["atomic-index"],
        score: scoreOwnIndexRow(p, q),
        ownIndex: true,
      }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score);

    const meta = await metaSearch(q, { page, perPage });

    // Meta first (as the user requested), then any own-index row that wasn't
    // already surfaced by the aggregators. Capped at `perPage`.
    const seen = new Set();
    const metaOrdered = [];
    for (const r of meta.results) {
      if (!r?.url || seen.has(r.url)) continue;
      seen.add(r.url);
      metaOrdered.push(r);
    }
    const ownTail = [];
    const ownCap = page === 1 ? 10 : 20;
    for (const r of ownRanked.slice(0, ownCap)) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      ownTail.push(r);
    }

    const merged = [...metaOrdered, ...ownTail].slice(0, perPage);

    // Pinned answer card — only on page 1, only if we already synthesised one
    // for this exact query on a previous search.
    const atomicAnswer = page === 1 ? await getAnswer(q).catch(() => null) : null;

    const out = {
      ...meta,
      results: merged,
      ownIndexCount: ownTail.length,
      atomicAnswer,
    };
    await cacheSet(key, { ...out, atomicAnswer: undefined }, SEARCH_TTL);
    growIndex(merged);
    rememberAnswer(q, merged);
    return c.json(out);
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

  // AI endpoint — opt-in. Clients only hit this when the user has AI enabled.
  async function computeAi(q) {
    if (!q) return { query: "", answer: "", sources: [] };
    // Short-circuit with the cached answer if we already synthesised one.
    const prior = await getAnswer(q).catch(() => null);
    if (prior?.answer) {
      return { query: q, mode: prior.mode || "synthesis", answer: prior.answer, sources: prior.sources || [], cached: true };
    }
    // Reuse the page-1 search cache if present — avoids a second full fan-out.
    const cacheKey = `search:${q.toLowerCase()}:p1:n50`;
    const cached = await cacheGet(cacheKey);
    let results;
    if (cached?.results?.length) {
      // Re-hydrate own-index bodies so synthesis has the full page text.
      const own = await searchPages(q, 10).catch(() => []);
      const byUrl = new Map(own.map((p) => [p.url, p]));
      results = cached.results.map((r) => (byUrl.has(r.url) ? { ...r, text: byUrl.get(r.url).text, ownIndex: true } : r));
    } else {
      const search = await metaSearch(q, { page: 1, perPage: 50 });
      await cacheSet(cacheKey, search, SEARCH_TTL);
      results = search.results;
    }
    const ai = await aiAnswer(q, results);
    if (ai?.answer) await putAnswer(q, { answer: ai.answer, mode: ai.mode, sources: ai.sources }).catch(() => {});
    return ai;
  }
  app.post("/api/ai", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const q = (body.q || c.req.query("q") || "").trim();
    return c.json(await computeAi(q));
  });
  // GET alias so the frontend can use a simple fetch + no preflight.
  app.get("/api/ai", async (c) => {
    const q = (c.req.query("q") || "").trim();
    return c.json(await computeAi(q));
  });

  app.post("/api/submit", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = (body.url || "").trim();
    if (!isSafeUrl(url)) return c.json({ ok: false, error: "Invalid URL" }, 400);
    await addSubmission(url);
    return c.json({ ok: true });
  });

  // Batch safety lookup — clients call this with up to 20 URLs at a time so
  // we can overlay a risk dot on each result card without a request-per-URL.
  app.post("/api/safety/batch", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const urls = Array.isArray(body.urls) ? body.urls.slice(0, 20) : [];
    const results = await Promise.all(
      urls.map(async (u) => {
        if (!isSafeUrl(u)) return { url: u, verdict: "unknown" };
        const ck = `safetyapi:${u}`;
        const cached = await cacheGet(ck);
        if (cached) return { url: u, ...cached, cached: true };
        const s = await safetyCheck(u);
        await cacheSet(ck, s, SAFETY_TTL);
        return { url: u, ...s };
      })
    );
    return c.json({ results });
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
    await cacheSet(cacheKey, summary, SAFETY_TTL);
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
    const color = verdict === "clean" ? "#16a34a"
      : verdict === "suspicious" ? "#f59e0b"
      : verdict === "malicious" ? "#dc2626"
      : "#6b7280";
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
<meta name="referrer" content="no-referrer">
<link rel="stylesheet" href="/css/themes.css">
<link rel="stylesheet" href="/css/styles.css">
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

  // Auth routes (Google OAuth + email magic link). No-op if not configured.
  app.route("/", buildAuthRoutes());

  // Download safety scanner. Logged-in only; falls back to a friendly error
  // if there's no VT key.
  app.post("/api/scan/file", async (c) => {
    const user = await currentUser(c);
    if (!user) {
      return c.json({ ok: false, error: "Sign in to use the download scanner." }, 401);
    }
    const body = await c.req.json().catch(() => ({}));
    const url = (body.url || "").trim();
    if (!url) return c.json({ ok: false, error: "Missing URL." }, 400);
    const out = await scanDownload(url);
    return c.json(out);
  });

  return app;
}

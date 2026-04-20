// Unified Hono application — the same app file is mounted by the Node,
// Vercel and Cloudflare Pages adapters. Kept intentionally tiny. All routes
// are stateless and never log user-identifying information.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { metaSearch, engineHealth } from "./aggregator.js";
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

// Semantic-ish scoring for own-index rows. We don't have embeddings (no
// external API, no local model that fits in Render free RAM), so we
// approximate relevance with three cheap signals:
//   (a) token COVERAGE in the title — fraction of query tokens present
//   (b) token COVERAGE in the body
//   (c) PHRASE proximity — whole-query match in title/body
// Title matches dominate. A title that covers ALL query tokens beats a
// body that just mentions one of them. Recency is a small tie-breaker.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "is", "are", "to", "in", "on", "for", "and", "or",
  "it", "be", "was", "were", "by", "at", "as", "this", "that", "with",
  "from", "what", "who", "why", "how", "do", "does", "did",
]);
function scoreOwnIndexRow(row, query) {
  const q = (query || "").toLowerCase().trim();
  if (!q) return 0;
  const title = (row.title || "").toLowerCase();
  const text = (row.text || "").toLowerCase();
  const rawTokens = q.split(/\s+/).filter((t) => t.length >= 2);
  const tokens = rawTokens.filter((t) => !STOPWORDS.has(t));
  const denom = Math.max(1, tokens.length || rawTokens.length);

  let titleHits = 0;
  let textHits = 0;
  for (const t of (tokens.length ? tokens : rawTokens)) {
    if (title.includes(t)) titleHits += 1;
    if (text.includes(t)) textHits += 1;
  }
  const titleCoverage = titleHits / denom;
  const textCoverage = textHits / denom;

  // Base score: title dominates (~5x body) and we reward full coverage
  // super-linearly so "all tokens in title" >> "half the tokens".
  let score = titleCoverage * 10 + textCoverage * 2;
  if (titleCoverage === 1) score += 3; // all tokens present in title
  if (textCoverage === 1) score += 1;

  // Phrase proximity — the whole query showing up verbatim is a strong
  // signal, especially in the title.
  if (q.length >= 4) {
    if (title.includes(q)) score += 4;
    else if (text.includes(q)) score += 1.5;
  }

  // Title-length prior: a 3-word title with all 3 tokens is a much
  // tighter match than a 50-word title that happens to include the
  // tokens somewhere.
  const titleLen = Math.max(1, title.split(/\s+/).length);
  if (titleHits === denom && titleLen <= denom * 3) score += 1.5;

  // Small freshness bonus — pages crawled in the last week.
  const age = Math.max(0, Date.now() - (row.indexed_at || 0));
  if (age < 7 * 24 * 3600 * 1000) score += 0.5;

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

  app.get("/api/stats", async (c) => {
    const s = await storageStats();
    return c.json({ ...s, engines: engineHealth() });
  });
  app.get("/api/health/engines", (c) => c.json(engineHealth()));

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

    // Own-index matches — fetched on every page. Strong hits (title match
    // OR very high score) are fused into the RRF pool as an additional
    // "engine", so they compete head-to-head with meta results. Weaker
    // tail matches are still appended below, gated by title-hit to avoid
    // body-word leaks (e.g. hono.dev mentioning "Google Fonts" on a query
    // for "google").
    const ownRaw = await searchPages(q, 30).catch(() => []);
    const ownScored = ownRaw.map((p) => {
      const score = scoreOwnIndexRow(p, q);
      const titleHit =
        (p.title || "").toLowerCase().includes((q || "").toLowerCase()) ||
        (q || "")
          .toLowerCase()
          .split(/\s+/)
          .filter((t) => t.length >= 2)
          .every((t) => (p.title || "").toLowerCase().includes(t));
      return {
        url: p.url,
        host: p.host,
        title: p.title,
        text: p.text,
        snippet: (p.text || "").slice(0, 240),
        engine: "atomic-index",
        score,
        titleHit,
        ownIndex: true,
      };
    });
    // Top-tier rows (strong match) go into the fusion pool as an extra list.
    const ownFused = ownScored
      .filter((r) => r.titleHit && r.score >= 3)
      .sort((a, b) => b.score - a.score)
      .slice(0, 15);
    // Second-tier rows (weaker but still title-hit) will be appended below
    // so we never lose recall on genuinely relevant in-index pages.
    const ownTailPool = ownScored
      .filter((r) => r.titleHit && r.score >= 1 && !ownFused.find((f) => f.url === r.url))
      .sort((a, b) => b.score - a.score);

    const meta = await metaSearch(q, {
      page,
      perPage,
      extraLists: ownFused.length ? [ownFused] : [],
    });

    const seen = new Set();
    const metaOrdered = [];
    for (const r of meta.results) {
      if (!r?.url || seen.has(r.url)) continue;
      seen.add(r.url);
      metaOrdered.push(r);
    }
    const ownTail = [];
    const ownCap = page === 1 ? 10 : 20;
    for (const r of ownTailPool.slice(0, ownCap)) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      ownTail.push({ ...r, engines: ["atomic-index"] });
    }

    const merged = [...metaOrdered, ...ownTail].slice(0, perPage);
    const ownIndexCount =
      metaOrdered.filter((r) => r.ownIndex).length + ownTail.length;

    // Pinned answer card — only on page 1, only if we already synthesised one
    // for this exact query on a previous search.
    const atomicAnswer = page === 1 ? await getAnswer(q).catch(() => null) : null;

    const out = {
      ...meta,
      results: merged,
      ownIndexCount,
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

  // /go is the click-through safety interstitial. It runs an instant VT
  // lookup (cached verdict is ~1ms; fresh lookups under 400ms) and then
  // offers the user two clearly-labelled choices:
  //   • View via Atomic proxy — secure & private (IP hidden, cookies stripped)
  //   • Open directly           — fast & reliable, leaks your IP to the site
  // The page is framework-free HTML + a tiny inline script (no external JS).
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

    // Kick off the scan server-side so the HTML already has the verdict
    // (cached → <1ms, uncached → ~300ms). If it takes longer than 600ms we
    // serve the page with a "scanning…" state and let the browser refresh
    // the verdict via /api/safety.
    const scanStartedAt = Date.now();
    const summaryOrNull = await Promise.race([
      safetyCheck(target).catch(() => null),
      new Promise((r) => setTimeout(() => r(null), 600)),
    ]);
    const scanMs = Date.now() - scanStartedAt;
    const summary = summaryOrNull || { verdict: "pending" };
    const verdict = summary.verdict || "unknown";
    const color = verdict === "clean" ? "#16a34a"
      : verdict === "suspicious" ? "#f59e0b"
      : verdict === "malicious" ? "#dc2626"
      : verdict === "pending" ? "#6366f1"
      : "#6b7280";
    const blurb = verdict === "clean" ? `No security vendors flagged this URL.`
      : verdict === "suspicious" ? `${summary.suspicious || 0} vendor(s) flagged this URL as suspicious.`
      : verdict === "malicious" ? `${summary.malicious || 0} vendor(s) flagged this URL as malicious.`
      : verdict === "unscanned" ? `Safety scanning is not configured on this server.`
      : verdict === "pending" ? `Scanning with VirusTotal…`
      : `This URL has not been analysed yet.`;
    const proxyUrl = `/proxy?url=${encodeURIComponent(target)}`;
    const directUrl = target.replace(/"/g, "&quot;");
    const escHost = host.replace(/</g, "&lt;");
    const escTarget = target.replace(/</g, "&lt;").replace(/"/g, "&quot;");
    const proxyLabel = verdict === "malicious" ? "View via proxy anyway" : "View via Atomic proxy";
    const directLabel = verdict === "malicious" ? "Open directly (unsafe)" : "Open directly";
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Safety check — Atomic Search</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<link rel="stylesheet" href="/css/themes.css">
<link rel="stylesheet" href="/css/styles.css">
<style>
  .go-card{max-width:640px;margin:56px auto;padding:28px;}
  .go-verdict{display:flex;align-items:center;gap:12px;margin-bottom:12px;flex-wrap:wrap}
  .go-dot{display:inline-block;width:12px;height:12px;border-radius:50%;background:${color};box-shadow:0 0 0 3px ${color}22}
  .go-dot.pending{animation:pulse 1.1s ease-in-out infinite}
  @keyframes pulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(.72);opacity:.55}}
  .go-verdict-label{font-weight:700;text-transform:capitalize;font-size:15px}
  .go-scan-ms{margin-left:auto;font-size:12px;color:var(--text-dim)}
  .go-box{border:1px solid var(--border);border-radius:14px;padding:20px;margin:18px 0 22px;background:var(--bg-elev,#1a1a22)}
  .go-url{margin:4px 0 0;color:var(--text-dim);font-size:13px;word-break:break-all}
  .go-actions{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .go-btn{display:block;padding:14px 18px;border-radius:12px;text-decoration:none;border:1px solid var(--border);transition:transform .08s ease}
  .go-btn:hover{transform:translateY(-1px)}
  .go-btn strong{display:block;font-size:15px;margin-bottom:2px}
  .go-btn small{display:block;color:var(--text-dim);font-size:12px;line-height:1.4}
  .go-btn.primary{background:var(--accent);color:#fff;border-color:transparent}
  .go-btn.primary small{color:#ffffffcc}
  .go-btn.direct{background:var(--bg-elev-2,transparent);color:var(--text)}
  .go-foot{margin-top:18px;display:flex;gap:16px;align-items:center;color:var(--text-dim);font-size:12px}
  .go-foot a{color:var(--text-dim)}
  @media(max-width:520px){.go-actions{grid-template-columns:1fr}}
</style>
</head><body data-theme="atom-dark" class="interstitial">
<main class="go-card">
  <h1 style="margin:0 0 4px">Leaving Atomic Search</h1>
  <p style="color:var(--text-dim);margin:0 0 18px">Before we send you on, we scanned this link with VirusTotal.</p>
  <div class="go-box">
    <div class="go-verdict">
      <span id="go-dot" class="go-dot ${verdict === "pending" ? "pending" : ""}"></span>
      <span id="go-label" class="go-verdict-label">${verdict}</span>
      <span class="go-scan-ms" id="go-scan-ms">${verdict === "pending" ? "scanning…" : `scanned in ${scanMs}ms`}</span>
    </div>
    <p id="go-blurb" style="margin:2px 0 0">${blurb}</p>
    <p class="go-url"><strong>${escHost}</strong> &nbsp; <span>${escTarget}</span></p>
  </div>
  <div class="go-actions">
    <a class="go-btn primary" href="${proxyUrl}">
      <strong>View via Atomic proxy</strong>
      <small>Secure &amp; private — your IP and cookies stay hidden.</small>
    </a>
    <a class="go-btn direct" href="${directUrl}" rel="noreferrer noopener nofollow">
      <strong>Open directly</strong>
      <small>Fast &amp; reliable — but the site will see your IP.</small>
    </a>
  </div>
  <div class="go-foot">
    <a href="/">← Back to results</a>
    <span>No history saved. Atomic never logs which links you click.</span>
  </div>
</main>
${verdict === "pending" ? `<script>
(async () => {
  try {
    const r = await fetch('/api/safety?url=' + encodeURIComponent(${JSON.stringify(target)}));
    const s = await r.json();
    const dot = document.getElementById('go-dot');
    const label = document.getElementById('go-label');
    const blurb = document.getElementById('go-blurb');
    const ms = document.getElementById('go-scan-ms');
    const color = s.verdict === 'clean' ? '#16a34a'
      : s.verdict === 'suspicious' ? '#f59e0b'
      : s.verdict === 'malicious' ? '#dc2626'
      : '#6b7280';
    dot.classList.remove('pending');
    dot.style.background = color;
    dot.style.boxShadow = '0 0 0 3px ' + color + '22';
    label.textContent = s.verdict || 'unknown';
    ms.textContent = 'scanned';
    blurb.textContent = s.verdict === 'clean' ? 'No security vendors flagged this URL.'
      : s.verdict === 'suspicious' ? (s.suspicious || 0) + ' vendor(s) flagged this URL as suspicious.'
      : s.verdict === 'malicious' ? (s.malicious || 0) + ' vendor(s) flagged this URL as malicious.'
      : s.verdict === 'unscanned' ? 'Safety scanning is not configured on this server.'
      : 'This URL has not been analysed yet.';
  } catch (e) { /* ignore */ }
})();
</script>` : ""}
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

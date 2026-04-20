// Unified Hono application — the same app file is mounted by the Node,
// Vercel and Cloudflare Pages adapters. Kept intentionally tiny. All routes
// are stateless and never log user-identifying information.

import { Hono } from "hono";
import { cors } from "hono/cors";
import { metaSearch, engineHealth } from "./aggregator.js";
import { metaImages } from "./images.js";
import { proxyHandler } from "./proxy.js";
import { safetyCheck } from "./safety.js";
import {
  cacheGet,
  cacheSet,
  searchPages,
  addSubmission,
  enqueueCrawl,
  stats as storageStats,
  pruneIndex,
  clearIndex,
} from "./storage.js";
import { isSafeUrl } from "./safeurl.js";
import { buildAuthRoutes, currentUser } from "./auth.js";
import { scanDownload, scanBuffer } from "./scan.js";
import { crawlOne } from "./crawler.js";
import { isNsfwResult, isNsfwText, isNsfwUrl } from "./nsfw.js";

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
// enqueue the rest for the background crawler to pick up. NSFW URLs are
// excluded from both the eager crawl and the queue — we never index them.
// Kicks off eager crawls for the top N URLs and queues the rest. Returns a
// promise that resolves when the top `awaitTop` eager crawls settle OR when
// `awaitBudgetMs` elapses (whichever comes first). Callers can `await` this
// slice to guarantee freshly-indexed Atomic hits surface on the very first
// search, while still letting the rest of the crawl run in the background.
function growIndex(
  results,
  { eager = 10, queueCap = 30, awaitTop = 0, awaitBudgetMs = 2500 } = {}
) {
  try {
    const urls = (results || [])
      .map((r) => r?.url)
      .filter((u) => u && isSafeUrl(u) && !isNsfwUrl(u));
    const head = urls.slice(0, eager);
    const eagerPromises = head.map((u) =>
      crawlOne(u, { timeoutMs: 5000 }).catch(() => false)
    );
    for (const u of urls.slice(eager, queueCap)) {
      enqueueCrawl(u).catch(() => {});
    }
    if (awaitTop > 0 && eagerPromises.length) {
      const topSlice = eagerPromises.slice(0, awaitTop);
      return Promise.race([
        Promise.all(topSlice),
        new Promise((r) => setTimeout(r, awaitBudgetMs)),
      ]).then(() => {});
    }
  } catch { /* ignore */ }
  return Promise.resolve();
}

// Build the Atomic-index-enriched result objects for a given query from the
// current storage snapshot. Pulled out so we can run it both before and
// after the eager crawl without duplicating the scoring/shaping logic.
async function buildOwnResults(q) {
  const ownRaw = await searchPages(q, 30).catch(() => []);
  return ownRaw.map((p) => {
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
      engines: ["atomic-index"],
      score,
      titleHit,
      ownIndex: true,
    };
  });
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

  // Admin: sweep junk rows that would fail today's quality gate (error
  // pages, login walls, thin placeholders, bot-check pages) without
  // touching the rest of the index.
  app.post("/api/admin/prune-index", async (c) => {
    const r = await pruneIndex();
    return c.json({ ok: true, ...r });
  });

  // Admin: wipe the Atomic index completely (pages + crawl queue + dead).
  // Use when the accumulated index is so messy you want a clean restart.
  // Cache and user submissions are preserved.
  app.post("/api/admin/clear-index", async (c) => {
    const ok = await clearIndex();
    return c.json({ ok });
  });

  app.get("/api/search", async (c) => {
    const q = (c.req.query("q") || "").trim();
    if (!q) return c.json({ query: "", results: [], page: 1, hasMore: false });
    // NSFW-intent queries get zero results. This is deliberate and not a
    // soft "safe search toggle" — the engine refuses to serve adult content
    // in any mode.
    if (isNsfwText(q)) {
      return c.json({
        query: q,
        results: [],
        page: 1,
        hasMore: false,
        filtered: true,
        message: "Adult content is not served by Atomic Search.",
      });
    }
    const page = Math.max(1, Math.min(20, Number(c.req.query("page")) || 1));
    const perPage = Math.max(10, Math.min(200, Number(c.req.query("per_page")) || 50));
    const key = `search:${q.toLowerCase()}:p${page}:n${perPage}`;

    // Helper: pulls the strong / tail Atomic-hit buckets out of the current
    // index state. Runs multiple times per request (before meta, after eager
    // crawl, and on cache hits) so every response reflects the freshest
    // index, not a stale snapshot from when the query was first cached.
    const splitOwn = async () => {
      const scored = await buildOwnResults(q);
      const fused = scored
        .filter((r) => r.titleHit && r.score >= 3)
        .sort((a, b) => b.score - a.score)
        .slice(0, 15);
      const tail = scored
        .filter((r) => r.titleHit && r.score >= 1 && !fused.find((f) => f.url === r.url))
        .sort((a, b) => b.score - a.score);
      return { fused, tail };
    };

    const cached = await cacheGet(key);
    if (cached) {
      // Re-run the own-index query LIVE even on cache hits. The meta slice
      // and ordering come from the cached response, but any pages we've
      // crawled since the cache was written get merged in so users actually
      // see the Atomic index growing instead of a frozen "0 from Atomic".
      const { fused, tail } = await splitOwn();
      const freshOwn = [...fused, ...tail];
      const seenCached = new Set();
      const ownTopFresh = [];
      const rest = [];
      for (const r of freshOwn) {
        if (!r.url || seenCached.has(r.url)) continue;
        seenCached.add(r.url);
        ownTopFresh.push(r);
      }
      for (const r of cached.results || []) {
        if (!r?.url) continue;
        if (r.ownIndex) continue; // replaced by freshOwn
        if (seenCached.has(r.url)) continue;
        seenCached.add(r.url);
        rest.push(r);
      }
      ownTopFresh.sort((a, b) => (b.score || 0) - (a.score || 0));
      const mergedFresh = [...ownTopFresh, ...rest].slice(0, perPage);
      const ownIndexCount = mergedFresh.filter((r) => r.ownIndex).length;
      // Fire-and-forget: keep growing the index on repeat searches too.
      growIndex(mergedFresh).catch(() => {});
      return c.json({ ...cached, results: mergedFresh, ownIndexCount, cached: true });
    }

    // Cold path: first time we've seen this query (in this cache window).
    // 1. Snapshot own-index hits we already have.
    // 2. Run meta search with strong hits fused into the RRF pool.
    // 3. Kick off eager crawl of top meta URLs and AWAIT a bounded slice so
    //    genuinely new results already exist in our index by the time we
    //    respond — i.e. the very first search for a new query can still
    //    show Atomic hits, not just on the repeat.
    // 4. Re-query own-index to pick up pages crawled during step 3.
    let { fused: ownFused, tail: ownTailPool } = await splitOwn();

    const meta = await metaSearch(q, {
      page,
      perPage,
      extraLists: ownFused.length ? [ownFused] : [],
    });

    // Eager-crawl top 5 meta URLs with a 2.5s budget. The rest are queued
    // for the background crawler as usual.
    await growIndex(meta.results, { awaitTop: 5, awaitBudgetMs: 2500 }).catch(() => {});
    // Re-query so newly-indexed pages surface on this same response.
    ({ fused: ownFused, tail: ownTailPool } = await splitOwn());

    // Order of precedence (top → bottom):
    //   1. Strong Atomic-index hits (our own crawler found & title-matched)
    //   2. Wikipedia knowledge card, if present
    //   3. Remaining Startpage / meta results in their RRF order
    //   4. Weaker Atomic-index tail matches (recall safety net)
    // The aggregator already fuses ownFused into its RRF pool, so "own"
    // items can appear anywhere in meta.results; we pull them to the top
    // here to honour the user's preference for Atomic-first surfacing.
    const seen = new Set();
    const ownTop = [];
    const wikiTop = [];
    const metaRest = [];
    // Seed ownTop from the *post-crawl* splitOwn so newly-indexed pages are
    // included even if they weren't in the meta.results RRF pool.
    for (const r of ownFused) {
      if (!r?.url || seen.has(r.url)) continue;
      seen.add(r.url);
      ownTop.push(r);
    }
    for (const r of meta.results) {
      if (!r?.url || seen.has(r.url)) continue;
      seen.add(r.url);
      if (r.ownIndex) { ownTop.push(r); continue; }
      if (/en\.wikipedia\.org\/wiki\//i.test(r.url)) { wikiTop.push(r); continue; }
      metaRest.push(r);
    }
    ownTop.sort((a, b) => (b.score || 0) - (a.score || 0));
    const wikiHead = wikiTop.slice(0, 1);
    const wikiRest = wikiTop.slice(1);

    const ownTail = [];
    const ownCap = page === 1 ? 10 : 20;
    for (const r of ownTailPool.slice(0, ownCap)) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      ownTail.push({ ...r, engines: ["atomic-index"] });
    }

    const ordered = [...ownTop, ...wikiHead, ...metaRest, ...wikiRest, ...ownTail]
      .filter((r) => !isNsfwResult(r));
    const merged = ordered.slice(0, perPage);
    const ownIndexCount = merged.filter((r) => r.ownIndex).length;

    const out = { ...meta, results: merged, ownIndexCount };
    await cacheSet(key, out, SEARCH_TTL);
    // The eager slice already awaited top-5; fire-and-forget the rest so the
    // index keeps growing in the background without adding latency.
    growIndex(merged, { eager: 10, queueCap: 30 }).catch(() => {});
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

  // AI feature removed — the synthesized-answer experience was unreliable
  // at this scale and the user asked to drop it entirely. If we ever want
  // it back, restore computeAi / /api/ai / rememberAnswer from git history.

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

  // Safety scanner — public, no login required. The Scan tab uses these
  // endpoints to let anyone check a URL or upload a file against VirusTotal
  // before opening / running it. All three modes share hash-first caching so
  // "known" files/URLs return instantly and we don't hammer VT.
  //
  //   • POST /api/scan/url      — scan a URL (domain/resource-level verdict)
  //   • POST /api/scan/file     — download a URL, hash it, check the file
  //   • POST /api/scan/upload   — multipart upload a file directly, scan it
  app.post("/api/scan/url", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = (body.url || "").trim();
    if (!url) return c.json({ ok: false, error: "Missing URL." }, 400);
    if (!isSafeUrl(url)) return c.json({ ok: false, error: "URL is not allowed." }, 400);
    const s = await safetyCheck(url);
    return c.json({ ok: true, url, ...s });
  });

  app.post("/api/scan/file", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const url = (body.url || "").trim();
    if (!url) return c.json({ ok: false, error: "Missing URL." }, 400);
    const out = await scanDownload(url);
    return c.json(out);
  });

  app.post("/api/scan/upload", async (c) => {
    try {
      const form = await c.req.parseBody();
      const file = form?.file;
      if (!file || typeof file === "string") {
        return c.json({ ok: false, error: "No file uploaded." }, 400);
      }
      const buf = Buffer.from(await file.arrayBuffer());
      const name = file.name || "upload.bin";
      const out = await scanBuffer(buf, name);
      return c.json(out);
    } catch (e) {
      return c.json({ ok: false, error: String(e?.message || e) }, 400);
    }
  });

  return app;
}

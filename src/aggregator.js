// Meta-search aggregator. Queries several public search endpoints, merges
// them with Reciprocal Rank Fusion, and presents results under Atomic's own
// brand — we deliberately do NOT expose which upstream ranked each result.
// All outbound requests are anonymous — no user-identifying headers.

import { parseHTML } from "linkedom";
import { privateFetch, hostFromUrl, normaliseUrl, stripTags, uniqBy } from "./util.js";

// Internal engine ids are used only for RRF / debugging. They are never
// leaked to the client (the /api/search response reports results as sourced
// from "atomic" only).
// Startpage gives us Google-sourced results through a privacy-preserving
// proxy, and Wikipedia gives us a reliable knowledge card for entity
// queries. That's the whole meta layer — the other engines were
// inconsistent and polluting results with off-topic pages (e.g. fishing
// rafts for "raft consensus algorithm"). The growing Atomic index fills
// in long-tail coverage.
const ENGINES = [
  "startpage",
  "wikipedia",
];

// With a smaller engine set we fan out more pages per engine so result
// volume stays healthy.
const ENGINE_PAGES_PER_META = 5;

// Pool of public SearXNG instances — tried round-robin until one answers.
const SEARXNG_POOL = [
  "https://searx.be",
  "https://searx.tiekoetter.com",
  "https://priv.au",
  "https://search.inetol.net",
  "https://paulgo.io",
  "https://search.projectsegfau.lt",
  "https://search.sapti.me",
];

function rankBlend(lists) {
  const k = 60;
  const scores = new Map();
  const items = new Map();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const key = normaliseUrl(item.url);
      if (!key) return;
      const prev = scores.get(key) || 0;
      scores.set(key, prev + 1 / (k + idx + 1));
      if (!items.has(key)) items.set(key, { ...item, url: key });
    });
  }
  const merged = [...items.values()].map((it) => ({
    ...it,
    score: scores.get(it.url) || 0,
  }));
  merged.sort((a, b) => b.score - a.score);
  return merged;
}

// ---------- per-engine parsers ----------

async function ddg(q, page = 1) {
  const s = (page - 1) * 20;
  const body = new URLSearchParams({ q, kl: "wt-wt", s: String(s) }).toString();
  const res = await privateFetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    timeout: 8000,
  });
  const html = await res.text();
  if (/anomaly-modal|Unusual activity/i.test(html)) return [];
  const { document } = parseHTML(html);
  const out = [];
  for (const r of document.querySelectorAll(".result, .web-result")) {
    const a = r.querySelector("a.result__a, .result__title a, h2 a");
    if (!a) continue;
    let href = a.getAttribute("href") || "";
    try {
      if (href.startsWith("//duckduckgo.com/l/") || href.startsWith("/l/")) {
        const u = new URL(href, "https://duckduckgo.com");
        href = u.searchParams.get("uddg") || href;
      }
    } catch { /* ignore */ }
    const title = stripTags(a.textContent || "");
    const snippet = stripTags(
      r.querySelector(".result__snippet, .result__body")?.textContent || ""
    );
    if (!href?.startsWith("http") || !title) continue;
    out.push({ url: href, title, snippet, engine: "ddg" });
    if (out.length >= 25) break;
  }
  return out;
}

function decodeBingRedirect(href) {
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith("bing.com") || !u.pathname.startsWith("/ck/a")) return href;
    const enc = u.searchParams.get("u");
    if (!enc) return href;
    const b64 = enc.replace(/^a1/, "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const decoded = typeof atob === "function"
      ? atob(b64 + pad)
      : Buffer.from(b64 + pad, "base64").toString("utf8");
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch { /* ignore */ }
  return href;
}

async function primary(q, page = 1) {
  // Bing HTML — force English US locale so results are useful regardless of
  // the server's geolocation (Cloudflare / Render datacenters sometimes
  // geolocate oddly). `mkt`, `cc`, `setlang` together pin it.
  const first = (page - 1) * 10 + 1;
  const url =
    `https://www.bing.com/search?q=${encodeURIComponent(q)}` +
    `&first=${first}&mkt=en-US&setlang=en-US&cc=US&form=QBLH`;
  const res = await privateFetch(url, {
    headers: {
      "Accept-Language": "en-US,en;q=0.9",
      Cookie: "SRCHHPGUSR=ADLT=OFF&IG=1&NRSLT=50; _EDGE_CD=m=en-us&u=en-us",
    },
    timeout: 8000,
  });
  const html = await res.text();
  const { document } = parseHTML(html);
  const out = [];
  for (const li of document.querySelectorAll("li.b_algo")) {
    const a = li.querySelector("h2 a");
    if (!a) continue;
    let href = a.getAttribute("href") || "";
    href = decodeBingRedirect(href);
    const title = stripTags(a.textContent || "");
    const snippet = stripTags(
      li.querySelector(".b_caption p")?.textContent || li.querySelector("p")?.textContent || ""
    );
    if (!href.startsWith("http") || !title) continue;
    // Drop obvious Chinese-language leaked results (happens when Bing
    // ignores our locale hints).
    if (/[\u4E00-\u9FFF]/.test(title) && !/[a-z]{4}/i.test(title)) continue;
    out.push({ url: href, title, snippet, engine: "primary" });
    if (out.length >= 25) break;
  }
  return out;
}

async function brave(q, page = 1) {
  const offset = (page - 1) * 10;
  const res = await privateFetch(
    `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web&offset=${offset}`,
    { timeout: 8000 }
  );
  if (res.status >= 400) return [];
  const html = await res.text();
  const { document } = parseHTML(html);
  const out = [];
  const nodes = document.querySelectorAll(
    "[data-type='web'] a, #results .snippet a, .snippet-title, .result a"
  );
  const seen = new Set();
  for (const a of nodes) {
    const href = a.getAttribute("href") || "";
    if (!href.startsWith("http") || seen.has(href)) continue;
    const title = stripTags(a.textContent || "");
    if (!title) continue;
    seen.add(href);
    let snippet = "";
    const container = a.closest(".snippet, [data-type='web'], .result") || a.parentElement;
    if (container) {
      const p = container.querySelector(".snippet-description, .snippet-content, p");
      snippet = stripTags(p?.textContent || "");
    }
    out.push({ url: href, title, snippet, engine: "brave" });
    if (out.length >= 25) break;
  }
  return out;
}

// Try SearXNG instances in order until one returns JSON results.
async function searxng(q, page = 1) {
  const configured = (typeof process !== "undefined" && process.env?.SEARXNG_URL) || "";
  const pool = configured ? [configured, ...SEARXNG_POOL] : SEARXNG_POOL;
  for (const base of pool) {
    try {
      const res = await privateFetch(
        `${base.replace(/\/$/, "")}/search?q=${encodeURIComponent(q)}&format=json&language=en&pageno=${page}`,
        { headers: { Accept: "application/json" }, timeout: 6000 }
      );
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (!data || !Array.isArray(data.results) || !data.results.length) continue;
      const out = [];
      for (const r of data.results) {
        if (!r.url || !r.title) continue;
        out.push({
          url: r.url,
          title: stripTags(r.title),
          snippet: stripTags(r.content || ""),
          engine: "searxng",
        });
        if (out.length >= 25) break;
      }
      if (out.length) return out;
    } catch { /* try next */ }
  }
  return [];
}

// Startpage — proxies Google anonymously, free and open. HTML has CSS-ish
// class-based markup we can parse.
async function startpage(q, page = 1) {
  try {
    const res = await privateFetch(
      `https://www.startpage.com/do/search?q=${encodeURIComponent(q)}&cat=web&pl=opensearch&page=${page}`,
      {
        headers: {
          "Accept-Language": "en-US,en;q=0.9",
          Referer: "https://www.startpage.com/",
        },
        timeout: 8000,
      }
    );
    if (!res.ok) return [];
    const html = await res.text();
    if (/captcha|anti-?bot|anomaly/i.test(html)) return [];
    const { document } = parseHTML(html);
    const out = [];
    const selectors = [
      "section.w-gl__result",
      ".w-gl__result",
      "article.result",
      ".result",
      "section.result",
      "[data-testid='result']",
    ];
    let nodes = [];
    for (const sel of selectors) {
      nodes = [...document.querySelectorAll(sel)];
      if (nodes.length) break;
    }
    for (const n of nodes) {
      const a =
        n.querySelector("a.w-gl__result-title") ||
        n.querySelector("a.result-link") ||
        n.querySelector("h3 a, h2 a") ||
        n.querySelector("a[href^='http']");
      if (!a) continue;
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("http")) continue;
      const title = stripTags(a.textContent || "");
      const snippet = stripTags(
        n.querySelector(".w-gl__description, .description, p")?.textContent || ""
      );
      if (!title) continue;
      out.push({ url: href, title, snippet, engine: "startpage" });
      if (out.length >= 25) break;
    }
    return out;
  } catch {
    return [];
  }
}

// Wikipedia OpenSearch — always-available, reliable knowledge source.
async function wikipedia(q, page = 1) {
  if (page > 1) return []; // OpenSearch doesn't paginate
  try {
    const res = await privateFetch(
      `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=20&namespace=0&search=${encodeURIComponent(q)}`,
      { headers: { Accept: "application/json" }, timeout: 6000 }
    );
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data) || data.length < 4) return [];
    const [, titles, snippets, urls] = data;
    const out = [];
    for (let i = 0; i < titles.length; i++) {
      if (!urls[i] || !titles[i]) continue;
      out.push({
        url: urls[i],
        title: titles[i],
        snippet: snippets[i] || "",
        engine: "wikipedia",
      });
    }
    return out;
  } catch {
    return [];
  }
}

// Marginalia — small-web / independent sites. Their HTML is simple.
async function marginalia(q, page = 1) {
  try {
    const res = await privateFetch(
      `https://search.marginalia.nu/search?query=${encodeURIComponent(q)}&profile=no-js&page=${page}`,
      { timeout: 6000 }
    );
    if (!res.ok) return [];
    const html = await res.text();
    const { document } = parseHTML(html);
    const out = [];
    for (const sec of document.querySelectorAll("section.card.search-result, section.search-result, .card.search-result")) {
      const a = sec.querySelector("h2 a, a.title, a");
      if (!a) continue;
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("http")) continue;
      const title = stripTags(a.textContent || "");
      const snippet = stripTags(sec.querySelector("p")?.textContent || "");
      if (!title) continue;
      out.push({ url: href, title, snippet, engine: "marginalia" });
      if (out.length >= 15) break;
    }
    return out;
  } catch {
    return [];
  }
}

const RUNNERS = { primary, ddg, brave, startpage, searxng, wikipedia, marginalia };

// ---------- Self-healing engine tracker ----------
// Every engine has an independent failure budget. Three consecutive failures
// (exception OR empty result) puts it in a 5-minute cooldown where we skip
// the HTTP call entirely. A single success resets it. This keeps the UI
// snappy when one upstream is flaky without permanently losing coverage.
const ENGINE_HEALTH = Object.fromEntries(
  ENGINES.map((e) => [e, { consecutiveFailures: 0, cooldownUntil: 0, totalCalls: 0, totalFailures: 0, lastError: null }])
);
const FAILURE_LIMIT = 3;
const COOLDOWN_MS = 5 * 60 * 1000;

function engineReady(engine) {
  const h = ENGINE_HEALTH[engine];
  if (!h) return true;
  return Date.now() >= h.cooldownUntil;
}

function recordEngineResult(engine, ok, err) {
  const h = ENGINE_HEALTH[engine];
  if (!h) return;
  h.totalCalls += 1;
  if (ok) {
    h.consecutiveFailures = 0;
    h.lastError = null;
    return;
  }
  h.consecutiveFailures += 1;
  h.totalFailures += 1;
  h.lastError = err ? String(err).slice(0, 160) : "empty";
  if (h.consecutiveFailures >= FAILURE_LIMIT) {
    h.cooldownUntil = Date.now() + COOLDOWN_MS;
    h.consecutiveFailures = 0; // reset so it tries again after cooldown
  }
}

export function engineHealth() {
  const now = Date.now();
  const out = {};
  for (const [engine, h] of Object.entries(ENGINE_HEALTH)) {
    out[engine] = {
      healthy: now >= h.cooldownUntil,
      cooldownMsLeft: Math.max(0, h.cooldownUntil - now),
      totalCalls: h.totalCalls,
      totalFailures: h.totalFailures,
      successRate: h.totalCalls
        ? Math.round(((h.totalCalls - h.totalFailures) / h.totalCalls) * 1000) / 10
        : null,
      lastError: h.lastError,
    };
  }
  return out;
}

export async function metaSearch(q, opts = {}) {
  if (!q || !q.trim()) {
    return { results: [], query: q, page: 1, perPage: 0, hasMore: false, total: 0 };
  }
  const query = q.trim().slice(0, 256);
  const page = Math.max(1, Number(opts.page) || 1);
  const pagesPerEngine = Math.max(1, Math.min(5, Number(opts.pagesPerEngine) || ENGINE_PAGES_PER_META));
  const perPage = Math.max(10, Math.min(200, Number(opts.perPage) || 100));
  // Optional: additional ranked lists from OTHER sources (e.g. our own
  // SQLite-indexed pages) that should be fused in via RRF. The caller
  // passes these as `extraLists: [[item,…], …]`. They get the same RRF
  // treatment as the public engines, so a strong atomic-index hit can
  // naturally rank ABOVE weak meta results.
  const extraLists = Array.isArray(opts.extraLists) ? opts.extraLists.filter(Array.isArray) : [];

  const jobs = [];
  for (const engine of ENGINES) {
    if (!engineReady(engine)) continue; // cooldown — skip this engine entirely
    const run = RUNNERS[engine];
    for (let i = 0; i < pagesPerEngine; i++) {
      const enginePage = (page - 1) * pagesPerEngine + (i + 1);
      jobs.push({
        engine,
        enginePage,
        promise: run(query, enginePage).then(
          (list) => ({ ok: true, list }),
          (err) => ({ ok: false, err, list: [] })
        ),
      });
    }
  }
  const resolved = await Promise.allSettled(jobs.map((j) => j.promise));

  const perEngineLists = {};
  const perEngineStatus = {};
  jobs.forEach((job, idx) => {
    const s = resolved[idx];
    const payload = s.status === "fulfilled" ? s.value : { ok: false, list: [] };
    const list = payload.list || [];
    (perEngineLists[job.engine] = perEngineLists[job.engine] || []).push({ enginePage: job.enginePage, list });
    perEngineStatus[job.engine] = perEngineStatus[job.engine] || { count: 0 };
    if (list.length) perEngineStatus[job.engine].count += list.length;
    // Record ONE outcome per engine per call (use the first page's result so
    // an engine isn't penalised 3x for being down).
    if (job.enginePage === (page - 1) * pagesPerEngine + 1) {
      recordEngineResult(job.engine, payload.ok && list.length > 0, payload.err);
    }
  });

  const flatLists = [];
  for (const [, pages] of Object.entries(perEngineLists)) {
    pages.sort((a, b) => a.enginePage - b.enginePage);
    const flat = [];
    for (const { list } of pages) flat.push(...list);
    if (flat.length) flatLists.push(flat);
  }
  // Fuse our own-index ranked list(s) in as additional "engines" so strong
  // Atomic hits can outrank weak meta hits via the same RRF math. The
  // caller is responsible for pre-filtering these to high-confidence rows.
  for (const extra of extraLists) {
    if (extra.length) flatLists.push(extra);
  }

  let merged = rankBlend(flatLists);
  // Preserve the `ownIndex` flag when it's present (so the UI can badge it).
  const ownUrls = new Set();
  for (const extra of extraLists) {
    for (const r of extra) if (r?.url) ownUrls.add(normaliseUrl(r.url));
  }
  merged = uniqBy(merged, (r) => r.url).map((r) => ({
    url: r.url,
    host: hostFromUrl(r.url),
    title: r.title,
    snippet: r.snippet,
    // Single, branded source — never leak the upstream engine id.
    engines: ["atomic"],
    ownIndex: ownUrls.has(r.url) || !!r.ownIndex,
    score: Math.round(r.score * 1000) / 1000,
  }));

  // Relevance filter: for multi-token queries, drop results where NEITHER
  // the title nor the snippet covers enough of the query. This kills the
  // "fishing raft" results for "raft consensus algorithm" problem —
  // upstream engines sometimes return pages that only share one word
  // with the query. Atomic-index rows and Wikipedia articles are exempt
  // (they're already strongly-matched signals).
  const relevanceStopwords = new Set([
    "the", "a", "an", "of", "is", "are", "to", "in", "on", "for", "and", "or",
    "it", "be", "was", "were", "by", "at", "as", "this", "that", "with",
    "from", "what", "who", "why", "how", "do", "does", "did",
  ]);
  const qAllTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const qTokens = qAllTokens.filter((t) => !relevanceStopwords.has(t));
  const effTokens = qTokens.length ? qTokens : qAllTokens;
  if (effTokens.length >= 2) {
    const minCoverage = 0.5; // must match at least half the meaningful tokens
    merged = merged.filter((r) => {
      if (r.ownIndex) return true;
      if (/en\.wikipedia\.org\/wiki\//.test(r.url)) return true;
      const title = (r.title || "").toLowerCase();
      const snip = (r.snippet || "").toLowerCase();
      const hay = title + " " + snip;
      const hits = effTokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
      return hits / effTokens.length >= minCoverage;
    });
  }

  // Knowledge-card promotion: if Wikipedia returned an article whose title
  // looks like it's ABOUT the query (i.e. contains every query token), hoist
  // it to position 0. This is the difference between "search 'google' →
  // support.google.com spam" and "search 'google' → Wikipedia's Google
  // article". Only triggers on page 1 so paged results aren't reshuffled.
  if (page === 1) {
    const wikiIdx = merged.findIndex((r) => {
      if (!/en\.wikipedia\.org\/wiki\//.test(r.url)) return false;
      const t = (r.title || "").toLowerCase();
      return qAllTokens.every((tok) => t.includes(tok));
    });
    if (wikiIdx > 0) {
      const [wiki] = merged.splice(wikiIdx, 1);
      merged.unshift(wiki);
    }
  }

  const hasMore = merged.length > perPage;
  const results = merged.slice(0, perPage);

  return {
    query,
    page,
    perPage,
    results,
    total: merged.length,
    hasMore,
    // Internal-only engine counts are omitted on purpose. Front-end doesn't
    // need them and we don't want to leak upstream identity.
  };
}

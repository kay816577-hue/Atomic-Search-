// src/aggregator.js — v6 Google-like + clean
// FIX: regel 621 = const wiki = merged.splice(best.i, 1)[0];

import { parseHTML } from "linkedom";
import { privateFetch, hostFromUrl, normaliseUrl, stripTags, uniqBy } from "./util.js";
import { isNsfwResult, isNsfwText } from "./nsfw.js";
import { rank, buildQueryContext } from "./ranking.js";

const ENGINES = [
  "startpage",
  "brave",
  "primary",
  "ddg",
  "wikipedia",
  "hackernews",
  "reddit",
...(((typeof process!== "undefined" && process.env?.ENABLE_MARGINALIA) === "1")
? ["marginalia"]
    : []),
];

const ENGINE_PAGES_PER_META = 3;

const SEARXNG_POOL = [
  "https://searx.be",
  "https://searx.tiekoetter.com",
  "https://priv.au",
  "https://search.inetol.net",
  "https://paulgo.io",
  "https://search.projectsegfau.lt",
  "https://search.sapti.me",
];

const AUTHORITY_TIERS = {
  "en.wikipedia.org": 3,
  "wikipedia.org": 3,
  "developer.mozilla.org": 3,
  "mdn.io": 3,
  "docs.python.org": 3,
  "pkg.go.dev": 3,
  "cppreference.com": 3,
  "rust-lang.org": 3,
  "doc.rust-lang.org": 3,
  "kernel.org": 3,
  "w3.org": 3,
  "rfc-editor.org": 3,
  "github.com": 2,
  "stackoverflow.com": 2,
  "stackexchange.com": 2,
  "arxiv.org": 2,
  "nature.com": 2,
  "science.org": 2,
  "nytimes.com": 2,
  "bbc.com": 2,
  "reuters.com": 2,
  "nasa.gov": 2,
  "who.int": 2,
  "cdc.gov": 2,
  "reddit.com": 1,
  "news.ycombinator.com": 1,
  "medium.com": 1,
  "dev.to": 1,
  "youtube.com": 1,
};

const WIKI_PREVIEW_CACHE = new Map();
const WIKI_PREVIEW_CAP = 500;

function wikiCacheGet(key) {
  if (!WIKI_PREVIEW_CACHE.has(key)) return null;
  const v = WIKI_PREVIEW_CACHE.get(key);
  WIKI_PREVIEW_CACHE.delete(key);
  WIKI_PREVIEW_CACHE.set(key, v);
  return v;
}

function wikiCacheSet(key, val) {
  if (WIKI_PREVIEW_CACHE.size >= WIKI_PREVIEW_CAP) {
    const oldest = WIKI_PREVIEW_CACHE.keys().next().value;
    if (oldest!== undefined) WIKI_PREVIEW_CACHE.delete(oldest);
  }
  WIKI_PREVIEW_CACHE.set(key, val);
}

async function enrichPreviews(results) {
  if (!Array.isArray(results) ||!results.length) return;

  for (const r of results) {
    if (!r.snippet) continue;
    r.preview = {
      source: r.ownIndex? "Atomic index" : "Web snippet",
      title: r.title,
      text: r.snippet.length > 360? r.snippet.slice(0, 360).trimEnd() + "…" : r.snippet,
      thumbnail: null,
    };
  }

  const wikiTargets = [];
  for (const r of results) {
    if (!/en\.wikipedia\.org\/wiki\//.test(r.url || "")) continue;
    const slug = decodeURIComponent((r.url.split("/wiki/")[1] || "")).split("#")[0].split("?")[0];
    if (!slug) continue;
    wikiTargets.push({ r, slug });
  }
  if (!wikiTargets.length) return;

  const BUDGET_MS = 6000;
  const PER_REQ_MS = 3500;
  const started = Date.now();

  await Promise.race([
    Promise.allSettled(
      wikiTargets.map(async ({ r, slug }) => {
        const cached = wikiCacheGet(slug);
        if (cached) { applyWikiPreview(r, cached); return; }
        if (Date.now() - started > BUDGET_MS) return;
        try {
          const res = await privateFetch(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`,
            { timeout: PER_REQ_MS, headers: { Accept: "application/json" } }
          );
          if (!res.ok) return;
          const j = await res.json();
          if (!j?.extract || isNsfwText(j.extract)) return;
          const payload = {
            title: j.title || null,
            text: j.extract.slice(0, 600),
            thumbnail: j.thumbnail?.source || null,
          };
          wikiCacheSet(slug, payload);
          applyWikiPreview(r, payload);
        } catch {}
      })
    ),
    new Promise((resolve) => setTimeout(resolve, BUDGET_MS)),
  ]);
}

function applyWikiPreview(r, p) {
  r.preview = {
    source: "Wikipedia",
    title: p.title,
    text: p.text,
    thumbnail: p.thumbnail,
  };
}

function synthesiseExtractive(results, query) {
  const top = results.slice(0, 6);
  const qTerms = query.toLowerCase().split(/\s+/).filter(t => t.length >= 3);
  if (!qTerms.length) return null;

  const sources = [];
  const seenHosts = new Set();
  const seenSentences = new Set();
  const picked = [];

  for (const r of top) {
    const text = (r.preview?.text || r.snippet || r.text || "").trim();
    if (!text || text.length < 40) continue;

    const sents = text
.replace(/\s+/g, " ")
.split(/(?<=[.!?])\s+(?=[A-Z"'])/)
.map(s => s.trim())
.filter(s => s.length >= 30 && s.length <= 260);

    const scored = sents
.map(s => {
        const l = s.toLowerCase();
        const hits = qTerms.reduce((n, t) => n + (l.includes(t)? 1 : 0), 0);
        return { s, hits };
      })
.filter(x => x.hits >= 1)
.sort((a, b) => b.hits - a.hits);

    if (!scored.length) continue;
    const best = scored[0].s;
    const key = best.slice(0, 60).toLowerCase();
    if (seenSentences.has(key)) continue;
    seenSentences.add(key);
    picked.push(best);

    if (!seenHosts.has(r.host)) {
      seenHosts.add(r.host);
      sources.push({ host: r.host, url: r.url, title: r.title });
    }
    if (picked.length >= 3) break;
  }

  if (!picked.length) return null;
  let text = picked.join(" ");
  if (text.length > 450) text = text.slice(0, 447) + "…";

  return {
    source: "Atomic synthesis",
    title: query,
    text,
    sources,
    thumbnail: null,
  };
}

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
  for (const r of document.querySelectorAll(".result,.web-result")) {
    const a = r.querySelector("a.result__a,.result__title a, h2 a");
    if (!a) continue;
    let href = a.getAttribute("href") || "";
    try {
      if (href.startsWith("//duckduckgo.com/l/") || href.startsWith("/l/")) {
        const u = new URL(href, "https://duckduckgo.com");
        href = u.searchParams.get("uddg") || href;
      }
    } catch {}
    const title = stripTags(a.textContent || "");
    const snippet = stripTags(r.querySelector(".result__snippet,.result__body")?.textContent || "");
    if (!href?.startsWith("http") ||!title) continue;
    out.push({ url: href, title, snippet, engine: "ddg" });
    if (out.length >= 25) break;
  }
  return out;
}

function decodeBingRedirect(href) {
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith("bing.com") ||!u.pathname.startsWith("/ck/a")) return href;
    const enc = u.searchParams.get("u");
    if (!enc) return href;
    const b64 = enc.replace(/^a1/, "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4? "=".repeat(4 - (b64.length % 4)) : "";
    const decoded = typeof atob === "function"? atob(b64 + pad) : Buffer.from(b64 + pad, "base64").toString("utf8");
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch {}
  return href;
}

async function primary(q, page = 1) {
  const first = (page - 1) * 10 + 1;
  const url = `https://www.bing.com/search?q=${encodeURIComponent(q)}&first=${first}&mkt=en-US&setlang=en-US&cc=US&form=QBLH`;
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
    const snippet = stripTags(li.querySelector(".b_caption p")?.textContent || li.querySelector("p")?.textContent || "");
    if (!href.startsWith("http") ||!title) continue;
    if (/[\u4E00-\u9FFF]/.test(title) &&!/[a-z]{4}/i.test(title)) continue;
    out.push({ url: href, title, snippet, engine: "primary" });
    if (out.length >= 25) break;
  }
  return out;
}

async function brave(q, page = 1) {
  const offset = (page - 1) * 10;
  const url = `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web&offset=${offset}&spellcheck=0&safesearch=moderate`;
  const res = await privateFetch(url, {
    headers: { Referer: "https://search.brave.com/", "Accept-Language": "en-US,en;q=0.9" },
    timeout: 8000,
  });
  if (res.status >= 400) return [];
  const html = await res.text();
  if (/bot[- ]?protection|captcha|challenge/i.test(html)) return [];
  const { document } = parseHTML(html);
  const out = [];
  const containers = document.querySelectorAll("[data-type='web'],.snippet, #results.snippet, article.snippet,.result");
  const seen = new Set();
  for (const c of containers) {
    const a = c.querySelector("a.result-header, a.h,.snippet-title a, a[href^='http']");
    if (!a) continue;
    const href = a.getAttribute("href") || "";
    if (!href.startsWith("http") || seen.has(href)) continue;
    const title = stripTags(c.querySelector(".snippet-title,.title, h2, h3,.result-header")?.textContent || a.textContent || "");
    if (!title) continue;
    seen.add(href);
    const snippet = stripTags(c.querySelector(".snippet-description,.snippet-content,.description, p")?.textContent || "");
    out.push({ url: href, title, snippet, engine: "brave" });
    if (out.length >= 25) break;
  }
  return out;
}

async function searxng(q, page = 1) {
  const configured = (typeof process!== "undefined" && process.env?.SEARXNG_URL) || "";
  const pool = configured? [configured,...SEARXNG_POOL] : SEARXNG_POOL;
  for (const base of pool) {
    try {
      const res = await privateFetch(
        `${base.replace(/\/$/, "")}/search?q=${encodeURIComponent(q)}&format=json&language=en&pageno=${page}`,
        { headers: { Accept: "application/json" }, timeout: 6000 }
      );
      if (!res.ok) continue;
      const data = await res.json().catch(() => null);
      if (!data ||!Array.isArray(data.results) ||!data.results.length) continue;
      const out = [];
      for (const r of data.results) {
        if (!r.url ||!r.title) continue;
        out.push({ url: r.url, title: stripTags(r.title), snippet: stripTags(r.content || ""), engine: "searxng" });
        if (out.length >= 25) break;
      }
      if (out.length) return out;
    } catch {}
  }
  return [];
}

async function startpage(q, page = 1) {
  try {
    const res = await privateFetch(
      `https://www.startpage.com/do/search?q=${encodeURIComponent(q)}&cat=web&pl=opensearch&page=${page}`,
      { headers: { "Accept-Language": "en-US,en;q=0.9", Referer: "https://www.startpage.com/" }, timeout: 8000 }
    );
    if (!res.ok) return [];
    const html = await res.text();
    if (/captcha|anti-?bot|anomaly/i.test(html)) return [];
    const { document } = parseHTML(html);
    const out = [];
    const selectors = ["section.w-gl__result", ".w-gl__result", "article.result", ".result", "section.result", "[data-testid='result']"];
    let nodes = [];
    for (const sel of selectors) {
      nodes = [...document.querySelectorAll(sel)];
      if (nodes.length) break;
    }
    for (const n of nodes) {
      const a = n.querySelector("a.w-gl__result-title") || n.querySelector("a.result-link") || n.querySelector("h3 a, h2 a") || n.querySelector("a[href^='http']");
      if (!a) continue;
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("http")) continue;
      const title = stripTags(a.textContent || "");
      const snippet = stripTags(n.querySelector(".w-gl__description,.description, p")?.textContent || "");
      if (!title) continue;
      out.push({ url: href, title, snippet, engine: "startpage" });
      if (out.length >= 25) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function wikipedia(q, page = 1) {
  if (page > 1) return [];
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
      if (!urls[i] ||!titles[i]) continue;
      out.push({ url: urls[i], title: titles[i], snippet: snippets[i] || "", engine: "wikipedia" });
    }
    return out;
  } catch {
    return [];
  }
}

async function marginalia(q, page = 1) {
  try {
    const res = await privateFetch(`https://search.marginalia.nu/search?query=${encodeURIComponent(q)}&profile=no-js&page=${page}`, { timeout: 6000 });
    if (!res.ok) return [];
    const html = await res.text();
    const { document } = parseHTML(html);
    const out = [];
    for (const sec of document.querySelectorAll("section.card.search-result, section.search-result,.card.search-result")) {
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

async function hackernews(q, page = 1) {
  if (page > 1) return [];
  try {
    const res = await privateFetch(`https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=15`, { headers: { Accept: "application/json" }, timeout: 6000 });
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!data ||!Array.isArray(data.hits)) return [];
    const out = [];
    for (const h of data.hits) {
      const url = h.url || (h.objectID? `https://news.ycombinator.com/item?id=${h.objectID}` : null);
      const title = (h.title || "").trim();
      if (!url ||!title) continue;
      out.push({
        url,
        title,
        snippet: (h.story_text || "").replace(/<[^>]+>/g, "").slice(0, 280) || `Hacker News · ${h.points || 0} points · ${h.num_comments || 0} comments`,
        engine: "hackernews",
      });
      if (out.length >= 15) break;
    }
    return out;
  } catch {
    return [];
  }
}

async function reddit(q, page = 1) {
  if (page > 1) return [];
  try {
    const res = await privateFetch(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=relevance&limit=15&t=all&raw_json=1`,
      { headers: { Accept: "application/json", "User-Agent": "atomic-search/1.0 (private metasearch)" }, timeout: 6000 }
    );
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const children = data?.data?.children;
    if (!Array.isArray(children)) return [];
    const out = [];
    for (const c of children) {
      const d = c?.data;
      if (!d) continue;
      const permalink = d.permalink? `https://www.reddit.com${d.permalink}` : null;
      const title = (d.title || "").trim();
      if (!permalink ||!title) continue;
      out.push({
        url: permalink,
        title,
        snippet: (d.selftext || "").slice(0, 280) || `r/${d.subreddit || "reddit"} · ${d.score || 0} upvotes · ${d.num_comments || 0} comments`,
        engine: "reddit",
      });
      if (out.length >= 15) break;
    }
    return out;
  } catch {
    return [];
  }
}

const RUNNERS = { primary, ddg, brave, startpage, searxng, wikipedia, marginalia, hackernews, reddit };

const ENGINE_HEALTH = Object.fromEntries(
  ENGINES.map(e => [e, { consecutiveFailures: 0, cooldownUntil: 0, totalCalls: 0, totalFailures: 0, lastError: null }])
);
const FAILURE_LIMIT = 3;
const COOLDOWN_MS = 5 * 60 * 1000;

function engineReady(engine) {
  const h = ENGINE_HEALTH[engine];
  return!h || Date.now() >= h.cooldownUntil;
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
  h.lastError = err? String(err).slice(0, 160) : "empty";
  if (h.consecutiveFailures >= FAILURE_LIMIT) {
    h.cooldownUntil = Date.now() + COOLDOWN_MS;
    h.consecutiveFailures = 0;
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
      successRate: h.totalCalls? Math.round(((h.totalCalls - h.totalFailures) / h.totalCalls) * 1000) / 10 : null,
      lastError: h.lastError,
    };
  }
  return out;
}

export async function metaSearch(q, opts = {}) {
  if (!q ||!q.trim()) {
    return { results: [], query: q, page: 1, perPage: 0, hasMore: false, total: 0 };
  }
  if (isNsfwText(q)) {
    return { results: [], query: q, page: 1, perPage: 0, hasMore: false, total: 0, filtered: true };
  }

  const query = q.trim().slice(0, 256);
  const page = Math.max(1, Number(opts.page) || 1);
  const pagesPerEngine = Math.max(1, Math.min(5, Number(opts.pagesPerEngine) || ENGINE_PAGES_PER_META));
  const perPage = Math.max(10, Math.min(200, Number(opts.perPage) || 100));
  const extraLists = Array.isArray(opts.extraLists)? opts.extraLists.filter(Array.isArray) : [];

  const jobs = [];
  for (const engine of ENGINES) {
    if (!engineReady(engine)) continue;
    const run = RUNNERS[engine];
    for (let i = 0; i < pagesPerEngine; i++) {
      const enginePage = (page - 1) * pagesPerEngine + (i + 1);
      jobs.push({
        engine,
        enginePage,
        promise: run(query, enginePage).then(
          list => ({ ok: true, list }),
          err => ({ ok: false, err, list: [] })
        ),
      });
    }
  }

  const resolved = await Promise.allSettled(jobs.map(j => j.promise));
  const perEngineLists = {};
  jobs.forEach((job, idx) => {
    const s = resolved[idx];
    const payload = s.status === "fulfilled"? s.value : { ok: false, list: [] };
    const list = payload.list || [];
    (perEngineLists[job.engine] = perEngineLists[job.engine] || []).push({ enginePage: job.enginePage, list });
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
  for (const extra of extraLists) {
    if (extra.length) flatLists.push(extra);
  }

  let merged = rank(query, flatLists.flat(), {
    authorityTier: AUTHORITY_TIERS,
    nEngines: {}
  });

  const ownUrls = new Set();
  for (const extra of extraLists) {
    for (const r of extra) if (r?.url) ownUrls.add(normaliseUrl(r.url));
  }

  merged = uniqBy(merged, r => r.url).map(r => {
    const host = hostFromUrl(r.url);
    return {
...r,
      host,
      ownIndex: ownUrls.has(r.url) ||!!r.ownIndex,
      engines: ["atomic"],
    };
  });

  merged = merged.filter(r =>!isNsfwResult(r));

  const ctx = buildQueryContext(query);
  if (ctx.tokens.length >= 2) {
    const minCoverage = 0.5;
    merged = merged.filter(r => {
      if (r.ownIndex) return true;
      if (/en\.wikipedia\.org\/wiki\//.test(r.url)) return true;
      const text = (r.title + " " + (r.snippet || "")).toLowerCase();
      const hits = ctx.tokens.reduce((n, t) => n + (text.includes(t)? 1 : 0), 0);
      return hits / ctx.tokens.length >= minCoverage;
    });
  }

  if (page === 1) {
    const wikiMatches = merged
  .map((r, i) => ({ r, i }))
  .filter(({ r }) => {
        if (!/en\.wikipedia\.org\/wiki\//.test(r.url)) return false;
        const t = (r.title || "").toLowerCase();
        return ctx.tokens.every(tok => t.includes(tok));
      })
  .sort((a, b) => (a.r.title || "").length - (b.r.title || "").length);

    if (wikiMatches.length && wikiMatches[0].i > 0) {
      const best = wikiMatches[0];
      const wiki = merged.splice(best.i, 1)[0];
      merged.unshift(wiki);
    }
  }

  if (page === 1) {
    const MAX_PER_HOST = 3;
    const counts = new Map();
    const head = [];
    const tail = [];
    for (const r of merged) {
      const h = (r.host || "").toLowerCase();
      const n = counts.get(h) || 0;
      if (r.ownIndex ||!h || n < MAX_PER_HOST) {
        counts.set(h, n + 1);
        head.push(r);
      } else {
        tail.push(r);
      }
    }
    merged = [...head,...tail];
  }

  const hasMore = merged.length > perPage;
  const results = merged.slice(0, perPage);

  await enrichPreviews(results);

  let instant = null;
  if (page === 1 && results.length) {
    const wiki = results.find(r => r.preview && r.preview.source === "Wikipedia");
    if (wiki) {
      instant = {
        source: "Wikipedia",
        title: wiki.preview.title || wiki.title,
        text: wiki.preview.text,
        url: wiki.url,
        thumbnail: wiki.preview.thumbnail || null,
        sources: [{ host: wiki.host, url: wiki.url, title: wiki.title }],
      };
    } else {
      const synth = synthesiseExtractive(results, query);
      if (synth) instant = synth;
    }
  }

  return {
    query,
    page,
    perPage,
    results,
    total: merged.length,
    hasMore,
    instant,
  };
}

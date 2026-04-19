// Meta-search aggregator. Queries several public search endpoints, merges
// them with Reciprocal Rank Fusion, and presents results under Atomic's own
// brand — we deliberately do NOT expose which upstream ranked each result.
// All outbound requests are anonymous — no user-identifying headers.

import { parseHTML } from "linkedom";
import { privateFetch, hostFromUrl, normaliseUrl, stripTags, uniqBy } from "./util.js";

// Internal engine ids are used only for RRF / debugging. They are never
// leaked to the client (the /api/search response reports results as sourced
// from "atomic" only).
const ENGINES = [
  "primary",      // Bing HTML (en-US forced)
  "ddg",          // DuckDuckGo HTML
  "brave",        // Brave Search HTML
  "startpage",    // Startpage HTML (free, Google-sourced, no tracking)
  "searxng",      // community SearXNG instance (first working one)
  "wikipedia",    // Wikipedia OpenSearch JSON
  "marginalia",   // Marginalia small-web index
];

const ENGINE_PAGES_PER_META = 3;

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

export async function metaSearch(q, opts = {}) {
  if (!q || !q.trim()) {
    return { results: [], query: q, page: 1, perPage: 0, hasMore: false, total: 0 };
  }
  const query = q.trim().slice(0, 256);
  const page = Math.max(1, Number(opts.page) || 1);
  const pagesPerEngine = Math.max(1, Math.min(5, Number(opts.pagesPerEngine) || ENGINE_PAGES_PER_META));
  const perPage = Math.max(10, Math.min(200, Number(opts.perPage) || 100));

  const jobs = [];
  for (const engine of ENGINES) {
    const run = RUNNERS[engine];
    for (let i = 0; i < pagesPerEngine; i++) {
      const enginePage = (page - 1) * pagesPerEngine + (i + 1);
      jobs.push({ engine, enginePage, promise: run(query, enginePage).catch(() => []) });
    }
  }
  const resolved = await Promise.allSettled(jobs.map((j) => j.promise));

  const perEngineLists = {};
  const perEngineStatus = {};
  jobs.forEach((job, idx) => {
    const s = resolved[idx];
    const list = s.status === "fulfilled" ? s.value : [];
    (perEngineLists[job.engine] = perEngineLists[job.engine] || []).push({ enginePage: job.enginePage, list });
    perEngineStatus[job.engine] = perEngineStatus[job.engine] || { count: 0 };
    if (list.length) perEngineStatus[job.engine].count += list.length;
  });

  const flatLists = [];
  for (const [, pages] of Object.entries(perEngineLists)) {
    pages.sort((a, b) => a.enginePage - b.enginePage);
    const flat = [];
    for (const { list } of pages) flat.push(...list);
    if (flat.length) flatLists.push(flat);
  }

  let merged = rankBlend(flatLists);
  merged = uniqBy(merged, (r) => r.url).map((r) => ({
    url: r.url,
    host: hostFromUrl(r.url),
    title: r.title,
    snippet: r.snippet,
    // Single, branded source — never leak the upstream engine id.
    engines: ["atomic"],
    score: Math.round(r.score * 1000) / 1000,
  }));
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

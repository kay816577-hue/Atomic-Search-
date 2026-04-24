// Meta-search aggregator. Queries several public search endpoints, merges
// them with Reciprocal Rank Fusion, and presents results under Atomic's own
// brand — we deliberately do NOT expose which upstream ranked each result.
// All outbound requests are anonymous — no user-identifying headers.

import { parseHTML } from "linkedom";
import { privateFetch, hostFromUrl, normaliseUrl, stripTags, uniqBy } from "./util.js";
import { isNsfwResult, isNsfwText } from "./nsfw.js";

// Internal engine ids are used only for RRF / debugging. They are never
// leaked to the client (the /api/search response reports results as sourced
// from "atomic" only).
// Layered for coverage + privacy:
//   - Startpage     : Google results through a privacy-preserving proxy
//   - Brave         : independent index, great for recent / long-tail web
//   - primary (Bing): broad corporate index with an opt-out locale pin
//   - DuckDuckGo    : yet another Bing-flavoured view for agreement weight
//   - Wikipedia     : reliable knowledge cards for entity queries
//   - Hacker News   : tech / news discussion
//   - Reddit        : real-user opinion for niche questions
// Marginalia is available as a runner but disabled by default (its small-web
// results kept landing on the first page for mainstream queries). Enable
// via ENABLE_MARGINALIA=1 if you specifically want small-web coverage.
// All engines are hit server-side with spoofed UA + no cookies → scraping
// happens on the user's behalf with no identity leak. The growing Atomic
// index fills in long-tail coverage across repeat searches.
const ENGINES = [
  "startpage",
  "brave",
  "primary",
  "ddg",
  "wikipedia",
  "hackernews",
  "reddit",
  ...(((typeof process !== "undefined" && process.env?.ENABLE_MARGINALIA) === "1")
    ? ["marginalia"]
    : []),
];

// With more engines online we can drop per-engine pagination fan-out
// slightly — we get more cross-source agreement instead of more pages.
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

// Hosts we trust enough to give a small ranking boost to when they match
// the query well. These aren't hard overrides — they're just priors that
// nudge genuinely-relevant popular-site results above spammy lookalikes.
// Tiered so e.g. Wikipedia outranks a forum even when both match equally.
const POPULAR_HOSTS = {
  // tier 3 — authoritative reference for the topic
  "en.wikipedia.org": 3,
  "wikipedia.org": 3,
  "developer.mozilla.org": 3,
  "mdn.io": 3,
  "docs.python.org": 3,
  "pkg.go.dev": 3,
  "cppreference.com": 3,
  "rust-lang.org": 3,
  "doc.rust-lang.org": 3,
  "ecma-international.org": 3,
  "whatwg.org": 3,
  "w3.org": 3,
  "rfc-editor.org": 3,
  "datatracker.ietf.org": 3,
  "kernel.org": 3,
  // tier 2 — broadly reliable technical / educational / newsy hubs
  "github.com": 2,
  "stackoverflow.com": 2,
  "stackexchange.com": 2,
  "arxiv.org": 2,
  "wolframalpha.com": 2,
  "archive.org": 2,
  "britannica.com": 2,
  "khanacademy.org": 2,
  "nature.com": 2,
  "science.org": 2,
  "nytimes.com": 2,
  "bbc.com": 2,
  "bbc.co.uk": 2,
  "theguardian.com": 2,
  "reuters.com": 2,
  "apnews.com": 2,
  "wsj.com": 2,
  "economist.com": 2,
  "ft.com": 2,
  "nasa.gov": 2,
  "who.int": 2,
  "cdc.gov": 2,
  "nih.gov": 2,
  // tier 1 — genuine community content
  "reddit.com": 1,
  "news.ycombinator.com": 1,
  "medium.com": 1,
  "dev.to": 1,
  "quora.com": 1,
  "youtube.com": 1,
};

function popularHostBoost(url) {
  try {
    const h = new URL(url).hostname.replace(/^www\./, "").toLowerCase();
    if (POPULAR_HOSTS[h]) return POPULAR_HOSTS[h];
    // Allow matching on parent domains too (e.g. en.wikipedia.org hits the
    // `wikipedia.org` entry if present).
    for (const [host, tier] of Object.entries(POPULAR_HOSTS)) {
      if (h.endsWith("." + host)) return tier;
    }
  } catch { /* ignore */ }
  return 0;
}

// Simple keyword-relevance score for an item. Not an embedding — we don't
// want to drag a 400MB model onto Render's free tier — but good enough to
// push results whose title+snippet actually cover the query tokens above
// results that just happen to share a word. Returns a 0..~2 scalar.
const QRY_STOPWORDS = new Set([
  "the", "a", "an", "of", "is", "are", "to", "in", "on", "for", "and", "or",
  "it", "be", "was", "were", "by", "at", "as", "this", "that", "with",
  "from", "what", "who", "why", "how", "do", "does", "did",
]);
// Suffixes sites commonly append to titles that we strip before doing
// exact-match checks. "Linux kernel - Wikipedia" should be treated as an
// exact match for the query "linux kernel".
const TITLE_SUFFIX_RE = /\s*[|\-–—·:]\s*(wikipedia(?:,\s*the\s*free\s*encyclopedia)?|wiki|mdn\s*web\s*docs|mdn|github|docs|documentation|official\s*site|home\s*page|home|blog)\s*$/i;
function stripTitleBrand(t) {
  return (t || "").replace(TITLE_SUFFIX_RE, "").trim();
}
function keywordRelevance(item, tokens) {
  if (!tokens || !tokens.length) return 0;
  const rawTitle = (item.title || "").toLowerCase();
  const title = stripTitleBrand(rawTitle).toLowerCase();
  const snip = (item.snippet || "").toLowerCase();
  const hay = title + " " + snip;
  let titleHits = 0;
  let hayHits = 0;
  for (const t of tokens) {
    if (title.includes(t)) titleHits += 1;
    if (hay.includes(t)) hayHits += 1;
  }
  const titleCov = titleHits / tokens.length;
  const hayCov = hayHits / tokens.length;
  // Title coverage dominates (fraction of tokens present in title), with a
  // bonus for whole-query phrase match in the title.
  let r = titleCov * 0.7 + hayCov * 0.3;
  const phrase = tokens.join(" ");
  if (phrase.length >= 4 && title.includes(phrase)) r += 0.2;
  // Strong exact-title match: the stripped title is exactly the query (or
  // a very close subset). "Linux kernel" query → title "Linux kernel" wins
  // over "Linux kernel version history". This is what makes the canonical
  // page outrank tangential ones.
  if (title === phrase) r += 0.8;
  else if (title.startsWith(phrase + " ") || title.startsWith(phrase + ":")) r += 0.4;
  else if (title.endsWith(" " + phrase)) r += 0.2;
  // Shortness preference: among results that all cover the query, shorter
  // titles tend to be more on-topic. Compare word-count of title vs tokens.
  if (titleCov === 1 && phrase.length >= 3) {
    const titleWords = title.split(/\s+/).filter(Boolean).length;
    const extra = Math.max(0, titleWords - tokens.length);
    // ~+0.25 when title is exactly the query, decaying as noise is added.
    r += 0.25 / (1 + extra * 0.5);
  }
  return Math.min(2.5, r);
}

// Give the root page of a site an extra nudge when the query matches the
// host. `kernel.org/` for "linux kernel" should beat a deep article on
// wiki that also matches. Only fires when the user's query actually
// mentions the domain's distinctive word.
function homepageBoost(url, tokens) {
  if (!tokens || tokens.length === 0) return 0;
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    if (path !== "" && path !== "/") return 0;
    if (u.search) return 0;
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    // Use the registered-domain root word (kernel.org → "kernel").
    const rootWord = host.split(".").slice(-2)[0] || host;
    for (const t of tokens) {
      if (t.length >= 3 && (rootWord === t || host.split(".").includes(t))) {
        return 1; // single flat tier — ranker multiplies this.
      }
    }
  } catch { /* ignore */ }
  return 0;
}

// Reciprocal Rank Fusion with a cross-source agreement boost + popular-site
// prior + keyword relevance weighting. When the exact same URL shows up in
// N different engines, that's a very strong signal — we multiply the RRF
// score so cross-confirmed pages float to the top. A matching popular host
// adds a small flat bonus, and a keyword-relevant title nudges the score
// up further so "matching keyword on a popular site" surfaces correctly.
function rankBlend(lists, query = "") {
  const k = 60;
  const scores = new Map();
  const sources = new Map(); // url -> Set<engine>
  const items = new Map();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const key = normaliseUrl(item.url);
      if (!key) return;
      const prev = scores.get(key) || 0;
      scores.set(key, prev + 1 / (k + idx + 1));
      const set = sources.get(key) || new Set();
      if (item.engine) set.add(item.engine);
      sources.set(key, set);
      if (!items.has(key)) items.set(key, { ...item, url: key });
    });
  }
  const qTokens = (query || "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !QRY_STOPWORDS.has(t));
  const merged = [...items.values()].map((it) => {
    const baseline = scores.get(it.url) || 0;
    const srcs = sources.get(it.url) || new Set();
    // 1 source: x1.0 (no boost), 2: x1.4, 3: x1.7, 4+: x1.9 — capped so
    // one widely-shared link can't bury a very strong but single-source hit.
    const agree = srcs.size;
    const agreeBoost = agree <= 1 ? 1 : Math.min(1.9, 1 + Math.log2(agree) * 0.6);
    const popTier = popularHostBoost(it.url);
    // Popular-host bonus is small (fractional) and additive on the RRF
    // baseline BEFORE the agreement multiplier, so it layers cleanly.
    const popBonus = popTier * 0.015;
    // Homepage of a host that matches the query gets a flat additive nudge
    // big enough to push kernel.org/ above kernel.org/docs/… when the
    // query is just "linux kernel".
    const homeBonus = homepageBoost(it.url, qTokens) * 0.04;
    // Keyword relevance multiplier: 0.6x at no coverage, up to ~2.1x for a
    // short exact-title match. The wider spread (vs the previous 0.8..1.5
    // band) is what actually lets title-matching beat cross-source agreement
    // on canonical-page queries.
    const kw = keywordRelevance(it, qTokens);
    const kwMult = 0.6 + kw * 0.9;
    return {
      ...it,
      score: (baseline + popBonus + homeBonus) * agreeBoost * kwMult,
      engines: Array.from(srcs),
      agreement: agree,
      popTier,
    };
  });
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
  const url =
    `https://search.brave.com/search?q=${encodeURIComponent(q)}` +
    `&source=web&offset=${offset}&spellcheck=0&safesearch=moderate`;
  // Brave occasionally 429s scrapers — if so, we already catch 4xx below and
  // let the self-healing engine tracker shove it into cooldown.
  const res = await privateFetch(url, {
    headers: {
      Referer: "https://search.brave.com/",
      "Accept-Language": "en-US,en;q=0.9",
    },
    timeout: 8000,
  });
  if (res.status >= 400) return [];
  const html = await res.text();
  // Brave's "press continue" interstitial when bot-detection trips.
  if (/bot[- ]?protection|captcha|challenge/i.test(html)) return [];
  const { document } = parseHTML(html);
  const out = [];
  // Layout has drifted over time: try the snippet/result containers first
  // (they pin one link per result → better snippet extraction), then fall
  // back to a link-scan.
  const containers = document.querySelectorAll(
    "[data-type='web'], .snippet, #results .snippet, article.snippet, .result"
  );
  const seen = new Set();
  for (const c of containers) {
    const a =
      c.querySelector("a.result-header, a.h, .snippet-title a, a[href^='http']");
    if (!a) continue;
    const href = a.getAttribute("href") || "";
    if (!href.startsWith("http") || seen.has(href)) continue;
    const title = stripTags(
      c.querySelector(".snippet-title, .title, h2, h3, .result-header")
        ?.textContent || a.textContent || ""
    );
    if (!title) continue;
    seen.add(href);
    const snippet = stripTags(
      c.querySelector(".snippet-description, .snippet-content, .description, p")
        ?.textContent || ""
    );
    out.push({ url: href, title, snippet, engine: "brave" });
    if (out.length >= 25) break;
  }
  if (out.length === 0) {
    // Fallback: broad link scan when selectors haven't matched anything.
    for (const a of document.querySelectorAll("a[href^='http']")) {
      const href = a.getAttribute("href") || "";
      if (!href.startsWith("http") || seen.has(href)) continue;
      if (/search\.brave\.com|brave\.com\//.test(href)) continue;
      const title = stripTags(a.textContent || "");
      if (!title || title.length < 6) continue;
      seen.add(href);
      out.push({ url: href, title, snippet: "", engine: "brave" });
      if (out.length >= 20) break;
    }
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

// Hacker News — Algolia-powered public JSON API, no key needed. Broad
// tech/news/discussion coverage that Startpage often misses.
async function hackernews(q, page = 1) {
  if (page > 1) return []; // one page is enough — we only keep top 15 anyway
  try {
    const res = await privateFetch(
      `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(q)}&tags=story&hitsPerPage=15`,
      { headers: { Accept: "application/json" }, timeout: 6000 }
    );
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    if (!data || !Array.isArray(data.hits)) return [];
    const out = [];
    for (const h of data.hits) {
      const url = h.url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : null);
      const title = (h.title || "").trim();
      if (!url || !title) continue;
      out.push({
        url,
        title,
        snippet: (h.story_text || "").replace(/<[^>]+>/g, "").slice(0, 280) || `Hacker News \u00b7 ${h.points || 0} points \u00b7 ${h.num_comments || 0} comments`,
        engine: "hackernews",
      });
      if (out.length >= 15) break;
    }
    return out;
  } catch {
    return [];
  }
}

// Reddit — public JSON search API, no key needed. Great for real-user
// opinions and niche questions. We ask for relevance and limit to 15.
async function reddit(q, page = 1) {
  if (page > 1) return [];
  try {
    const res = await privateFetch(
      `https://www.reddit.com/search.json?q=${encodeURIComponent(q)}&sort=relevance&limit=15&t=all&raw_json=1`,
      {
        headers: {
          Accept: "application/json",
          "User-Agent": "atomic-search/1.0 (private metasearch)",
        },
        timeout: 6000,
      }
    );
    if (!res.ok) return [];
    const data = await res.json().catch(() => null);
    const children = data?.data?.children;
    if (!Array.isArray(children)) return [];
    const out = [];
    for (const c of children) {
      const d = c?.data;
      if (!d) continue;
      const permalink = d.permalink ? `https://www.reddit.com${d.permalink}` : null;
      const title = (d.title || "").trim();
      if (!permalink || !title) continue;
      out.push({
        url: permalink,
        title,
        snippet: (d.selftext || "").slice(0, 280) || `r/${d.subreddit || "reddit"} \u00b7 ${d.score || 0} upvotes \u00b7 ${d.num_comments || 0} comments`,
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
  // Refuse adult-intent queries up front. Nothing is even dispatched to
  // upstream engines. Callers can see `filtered: true` on the response.
  if (isNsfwText(q)) {
    return { results: [], query: q, page: 1, perPage: 0, hasMore: false, total: 0, filtered: true };
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

  let merged = rankBlend(flatLists, query);
  // Preserve the `ownIndex` flag when it's present (so the UI can badge it).
  const ownUrls = new Set();
  for (const extra of extraLists) {
    for (const r of extra) if (r?.url) ownUrls.add(normaliseUrl(r.url));
  }
  // Tokens used for relevance filter + "why this result" signal building.
  const relevanceStopwords = new Set([
    "the", "a", "an", "of", "is", "are", "to", "in", "on", "for", "and", "or",
    "it", "be", "was", "were", "by", "at", "as", "this", "that", "with",
    "from", "what", "who", "why", "how", "do", "does", "did",
  ]);
  const qAllTokens = query.toLowerCase().split(/\s+/).filter((t) => t.length >= 2);
  const qTokens = qAllTokens.filter((t) => !relevanceStopwords.has(t));
  const effTokens = qTokens.length ? qTokens : qAllTokens;
  // Build the "why this result" signals so the UI can show the user what
  // actually contributed to a result's position. We never leak upstream
  // engine names — everything here is either generic ("X engines agreed")
  // or an Atomic-internal signal (ownIndex, popularHost, titleMatch).
  merged = uniqBy(merged, (r) => r.url).map((r) => {
    const titleLc = stripTitleBrand((r.title || "").toLowerCase());
    const phrase = qTokens.join(" ");
    const kwCov = qTokens.length
      ? qTokens.reduce((n, t) => n + (titleLc.includes(t) ? 1 : 0), 0) / qTokens.length
      : 0;
    const signals = {
      agreement: r.agreement || 1,
      popularHostTier: r.popTier || 0,
      ownIndex: ownUrls.has(r.url) || !!r.ownIndex,
      titleExact: phrase.length >= 3 && titleLc === phrase,
      titlePrefix: phrase.length >= 3 && (titleLc.startsWith(phrase + " ") || titleLc.startsWith(phrase + ":")),
      homepage: homepageBoost(r.url, qTokens) > 0,
      keywordCoverage: Math.round(kwCov * 100) / 100,
    };
    return {
      url: r.url,
      host: hostFromUrl(r.url),
      title: r.title,
      snippet: r.snippet,
      // Single, branded source — never leak the upstream engine id.
      engines: ["atomic"],
      ownIndex: signals.ownIndex,
      score: Math.round(r.score * 1000) / 1000,
      signals,
    };
  });
  // Defense-in-depth NSFW filter. Even though the search endpoint also
  // filters, upstream engines occasionally leak adult content on otherwise
  // innocent queries — strip them here too.
  merged = merged.filter((r) => !isNsfwResult(r));

  // Relevance filter: for multi-token queries, drop results where NEITHER
  // the title nor the snippet covers enough of the query. This kills the
  // "fishing raft" results for "raft consensus algorithm" problem —
  // upstream engines sometimes return pages that only share one word
  // with the query. Atomic-index rows and Wikipedia articles are exempt
  // (they're already strongly-matched signals).
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
  // it to position 0. Among multiple matches we pick the SHORTEST title —
  // "Linux kernel" beats "Linux kernel version history" beats
  // "Linux kernel mailing list". Only triggers on page 1 so paged results
  // aren't reshuffled.
  if (page === 1) {
    const wikiMatches = merged
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => {
        if (!/en\.wikipedia\.org\/wiki\//.test(r.url)) return false;
        const t = (r.title || "").toLowerCase();
        return qAllTokens.every((tok) => t.includes(tok));
      })
      .sort((a, b) => (a.r.title || "").length - (b.r.title || "").length);
    if (wikiMatches.length && wikiMatches[0].i > 0) {
      const best = wikiMatches[0];
      const [wiki] = merged.splice(best.i, 1);
      merged.unshift(wiki);
    }
  }

  // Host-diversity cap on page 1: don't let a single host occupy more than
  // N slots in the top results. This prevents Reddit / forum link-dumps
  // from crowding out authoritative sources. Own-index hits are exempt.
  if (page === 1) {
    const MAX_PER_HOST = 3;
    const counts = new Map();
    const head = [];
    const tail = [];
    for (const r of merged) {
      const h = (r.host || "").toLowerCase();
      const n = counts.get(h) || 0;
      if (r.ownIndex || !h || n < MAX_PER_HOST) {
        counts.set(h, n + 1);
        head.push(r);
      } else {
        tail.push(r);
      }
    }
    merged = [...head, ...tail];
  }

  const hasMore = merged.length > perPage;
  const results = merged.slice(0, perPage);

  // Instant-answer box (top-of-page). Only on page 1. Best-effort: we look
  // for a Wikipedia match and fetch its summary via the public REST extract
  // API (anonymous, no key). If Wikipedia has no extract, we fall back to
  // the best on-topic snippet from the top results.
  let instant = null;
  if (page === 1 && results.length) {
    try {
      const wiki = results.find((r) => /en\.wikipedia\.org\/wiki\//.test(r.url));
      if (wiki) {
        const slug = decodeURIComponent(wiki.url.split("/wiki/")[1] || "").split("#")[0];
        if (slug) {
          const res = await privateFetch(
            `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(slug)}`,
            { timeout: 4000, headers: { Accept: "application/json" } }
          );
          if (res.ok) {
            const j = await res.json();
            if (j?.extract && !isNsfwText(j.extract)) {
              instant = {
                source: "Wikipedia",
                title: j.title || wiki.title,
                text: j.extract.slice(0, 600),
                url: wiki.url,
                thumbnail: j.thumbnail?.source || null,
              };
            }
          }
        }
      }
      if (!instant) {
        // Fallback: synthesise from the strongest on-topic snippet.
        const cand = results.find((r) => r.snippet && r.snippet.length > 80);
        if (cand) {
          instant = {
            source: cand.ownIndex ? "Atomic index" : "Top result",
            title: cand.title,
            text: cand.snippet.slice(0, 400),
            url: cand.url,
            thumbnail: null,
          };
        }
      }
    } catch { /* instant answer is best-effort, never fatal */ }
  }

  return {
    query,
    page,
    perPage,
    results,
    total: merged.length,
    hasMore,
    instant,
    // Internal-only engine counts are omitted on purpose. Front-end doesn't
    // need them and we don't want to leak upstream identity.
  };
}

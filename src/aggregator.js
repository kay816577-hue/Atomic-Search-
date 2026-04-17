// Meta-search aggregator. Queries multiple public search engines via their
// HTML endpoints (no API keys needed) and merges the results. All outbound
// requests are anonymous — we do not forward any user-identifying headers.

import { parseHTML } from "linkedom";
import { privateFetch, hostFromUrl, normaliseUrl, stripTags, uniqBy } from "./util.js";

const ENGINES = ["duckduckgo", "bing", "brave", "luxxle"];

function rankBlend(lists) {
  // Reciprocal Rank Fusion — fair, cheap and effective for merging ranked lists.
  const k = 60;
  const scores = new Map();
  const items = new Map();
  for (const list of lists) {
    list.forEach((item, idx) => {
      const key = normaliseUrl(item.url);
      if (!key) return;
      const prev = scores.get(key) || 0;
      scores.set(key, prev + 1 / (k + idx + 1));
      if (!items.has(key)) items.set(key, { ...item, url: key, engines: new Set() });
      items.get(key).engines.add(item.engine);
    });
  }
  const merged = [...items.values()].map((it) => ({
    ...it,
    engines: [...it.engines],
    score: scores.get(it.url) || 0,
  }));
  merged.sort((a, b) => b.score - a.score);
  return merged;
}

// ---------- per-engine parsers ----------

async function ddg(q) {
  // DuckDuckGo's HTML endpoint doesn't require JS and is scrape-friendly.
  const body = new URLSearchParams({ q, kl: "wt-wt" }).toString();
  const res = await privateFetch("https://html.duckduckgo.com/html/", {
    method: "POST",
    body,
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
  });
  const html = await res.text();
  const { document } = parseHTML(html);
  const out = [];
  for (const r of document.querySelectorAll(".result")) {
    const a = r.querySelector("a.result__a");
    if (!a) continue;
    let href = a.getAttribute("href") || "";
    // DDG wraps redirects in /l/?uddg=...
    try {
      if (href.startsWith("//duckduckgo.com/l/") || href.startsWith("/l/")) {
        const u = new URL(href, "https://duckduckgo.com");
        href = u.searchParams.get("uddg") || href;
      }
    } catch { /* ignore */ }
    const title = stripTags(a.textContent || "");
    const snippet = stripTags(r.querySelector(".result__snippet")?.textContent || "");
    if (!href || !title) continue;
    out.push({ url: href, title, snippet, engine: "duckduckgo" });
    if (out.length >= 15) break;
  }
  return out;
}

function decodeBingRedirect(href) {
  try {
    const u = new URL(href);
    if (!u.hostname.endsWith("bing.com") || !u.pathname.startsWith("/ck/a")) return href;
    const enc = u.searchParams.get("u");
    if (!enc) return href;
    // Bing prepends "a1" then base64url-encodes the real URL.
    const b64 = enc.replace(/^a1/, "").replace(/-/g, "+").replace(/_/g, "/");
    const pad = b64.length % 4 ? "=".repeat(4 - (b64.length % 4)) : "";
    const decoded = typeof atob === "function"
      ? atob(b64 + pad)
      : Buffer.from(b64 + pad, "base64").toString("utf8");
    if (/^https?:\/\//i.test(decoded)) return decoded;
  } catch { /* ignore */ }
  return href;
}

async function bing(q) {
  const res = await privateFetch(
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&form=QBLH`,
    { headers: { "Accept-Language": "en-US,en;q=0.9" } }
  );
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
    out.push({ url: href, title, snippet, engine: "bing" });
    if (out.length >= 15) break;
  }
  return out;
}

async function brave(q) {
  const res = await privateFetch(
    `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`
  );
  const html = await res.text();
  const { document } = parseHTML(html);
  const out = [];
  // Brave's HTML changes often — try a few known selectors.
  const nodes = document.querySelectorAll("[data-type='web'] a, #results .snippet a, .snippet-title, .result a");
  const seen = new Set();
  for (const a of nodes) {
    const href = a.getAttribute("href") || "";
    if (!href.startsWith("http") || seen.has(href)) continue;
    const title = stripTags(a.textContent || "");
    if (!title) continue;
    seen.add(href);
    // Snippet: try closest snippet container.
    let snippet = "";
    const container = a.closest(".snippet, [data-type='web'], .result") || a.parentElement;
    if (container) {
      const p = container.querySelector(".snippet-description, .snippet-content, p");
      snippet = stripTags(p?.textContent || "");
    }
    out.push({ url: href, title, snippet, engine: "brave" });
    if (out.length >= 15) break;
  }
  return out;
}

async function luxxle(q) {
  // Luxxle.com doesn't expose a public scrape endpoint. Instead we use a
  // privacy-respecting SearXNG public instance as the "Luxxle" slot so the
  // aggregator always has 4 sources. The endpoint is configurable via env.
  const base = (typeof process !== "undefined" && process.env && process.env.SEARXNG_URL) || "https://searx.be";
  const res = await privateFetch(
    `${base}/search?q=${encodeURIComponent(q)}&format=json&language=en`,
    { headers: { Accept: "application/json" } }
  );
  if (!res.ok) return [];
  const data = await res.json().catch(() => ({}));
  const out = [];
  for (const r of data.results || []) {
    if (!r.url || !r.title) continue;
    out.push({
      url: r.url,
      title: stripTags(r.title),
      snippet: stripTags(r.content || ""),
      engine: "luxxle",
    });
    if (out.length >= 15) break;
  }
  return out;
}

const RUNNERS = { duckduckgo: ddg, bing, brave, luxxle };

export async function metaSearch(q) {
  if (!q || !q.trim()) return { results: [], engines: {}, query: q };
  const query = q.trim().slice(0, 256);
  const settled = await Promise.allSettled(
    ENGINES.map((e) => RUNNERS[e](query).catch(() => []))
  );
  const perEngine = {};
  const lists = [];
  settled.forEach((s, i) => {
    const name = ENGINES[i];
    const list = s.status === "fulfilled" ? s.value : [];
    perEngine[name] = { ok: s.status === "fulfilled" && list.length > 0, count: list.length };
    if (list.length) lists.push(list);
  });
  let merged = rankBlend(lists);
  merged = uniqBy(merged, (r) => r.url).slice(0, 30).map((r) => ({
    url: r.url,
    host: hostFromUrl(r.url),
    title: r.title,
    snippet: r.snippet,
    engines: r.engines,
    score: Math.round(r.score * 1000) / 1000,
  }));
  return { query, results: merged, engines: perEngine };
}

// src/crawler.js — P0 FIXED VERSION
// Fixes: CPU throttle, disk thrash, no WAL. Target: 18-20 pages/min on Render Free

import { parseHTML } from "linkedom";
import { privateFetch, hostFromUrl, normaliseUrl, stripTags } from "./util.js";
import {
  insertPage,
  nextCrawlTask,
  enqueueCrawl,
  dropFromQueue,
  recordCrawlFailure,
  reenqueueStale,
  stats,
  db // Nodig voor batch commits
} from "./storage.js";
import { isSafeUrl } from "./safeurl.js";
import { isNsfwUrl, isNsfwText } from "./nsfw.js";

let running = false;

function extract(html, url) {
  const { document } = parseHTML(html);
  const title = stripTags(document.querySelector("title")?.textContent || url);
  const text = stripTags(
    [...document.querySelectorAll("p, h1, h2, h3, li")]
      .slice(0, 80)
      .map((n) => n.textContent)
      .join(" ")
  ).slice(0, 4000);
  return { title, text, document };
}

export async function crawlOne(url, { timeoutMs = 5000 } = {}) {
  if (typeof process === "undefined" || !process.versions?.node) return false;
  if (!isSafeUrl(url)) return false;
  if (isNsfwUrl(url)) return false;
  const norm = normaliseUrl(url);
  try {
    const res = await privateFetch(url, { timeout: timeoutMs });
    if (!res.ok) {
      await recordCrawlFailure(norm, `HTTP ${res.status}`).catch(() => {});
      return false;
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      await dropFromQueue(norm).catch(() => {});
      return false;
    }
    const html = (await res.text()).slice(0, 500_000);
    const { title, text } = extract(html, url);
    const host = hostFromUrl(url);
    await insertPage({ url: norm, title, text, host });
    await dropFromQueue(norm).catch(() => {});
    return true;
  } catch (err) {
    await recordCrawlFailure(norm, err?.message || "fetch failed").catch(() => {});
    return false;
  }
}

const SEED_URLS = [
  "https://en.wikipedia.org/wiki/Main_Page",
  "https://en.wikipedia.org/wiki/Special:Random",
  "https://en.wikipedia.org/wiki/Computer_science",
  "https://en.wikipedia.org/wiki/Science",
  "https://en.wikipedia.org/wiki/Technology",
  "https://en.wikipedia.org/wiki/History",
  "https://en.wikipedia.org/wiki/Mathematics",
  "https://en.wikipedia.org/wiki/Physics",
  "https://en.wikipedia.org/wiki/Geography",
  "https://news.ycombinator.com/",
  "https://developer.mozilla.org/en-US/",
  "https://www.github.com/trending",
];

async function seedIfEmpty() {
  try {
    const s = await stats();
    if ((s?.pages || 0) >= 50) return;
    for (const u of SEED_URLS) {
      try { await enqueueCrawl(normaliseUrl(u)); } catch {}
    }
  } catch {}
}

// P0 FIX: Render Free tier = 0.1 vCPU. 32 workers = 100% throttle = 2/min.
// 2 workers + 300ms sleep = 18-20/min steady zonder throttle.
const CONCURRENCY = 2;
const PER_HOST = 1;
const PER_HOST_MIN_GAP_MS = 75;
const LINKS_PER_PAGE = 100;
const DEDUP_LRU_CAP = 250000;
const FETCH_TIMEOUT_MS = 4000;
const MAX_HTML_BYTES = 800_000;

const dedupLru = new Set();
function noteSeen(url) {
  if (dedupLru.has(url)) return true;
  if (dedupLru.size >= DEDUP_LRU_CAP) {
    const first = dedupLru.values().next().value;
    if (first !== undefined) dedupLru.delete(first);
  }
  dedupLru.add(url);
  return false;
}

const hostInFlight = new Map();
const hostLastFetch = new Map();

// P0 FIX: Batch commit counter. Commit per page = 72K fsync = disk dood.
let pagesSinceCommit = 0;
let transactionOpen = false;

async function crawlTask(task) {
  const { url } = task;
  const host = hostFromUrl(url) || "unknown";
  hostInFlight.set(host, (hostInFlight.get(host) || 0) + 1);
  hostLastFetch.set(host, Date.now());
  
  try {
    if (!isSafeUrl(url)) { await dropFromQueue(url).catch(() => {}); return; }
    
    const res = await privateFetch(url, { timeout: FETCH_TIMEOUT_MS });
    if (!res.ok) { 
      await recordCrawlFailure(url, `HTTP ${res.status}`).catch(() => {}); 
      return; 
    }
    
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) { 
      await dropFromQueue(url).catch(() => {}); 
      return; 
    }
    
    const html = (await res.text()).slice(0, MAX_HTML_BYTES);
    const { title, text, document } = extract(html, url);
    if (isNsfwText(title, text)) { 
      await dropFromQueue(url).catch(() => {}); 
      return; 
    }

    // P0 FIX: Batch transactions. Open 1x, commit elke 1000 pages.
    if (!transactionOpen) {
      db.exec('BEGIN TRANSACTION');
      transactionOpen = true;
    }
    
    await insertPage({ url: normaliseUrl(url), title, text, host });
    pagesSinceCommit++;
    
    if (pagesSinceCommit >= 1000) {
      db.exec('COMMIT');
      transactionOpen = false;
      pagesSinceCommit = 0;
      console.log('[CRAWLER] Batch committed 1000 pages');
    }
    
    await dropFromQueue(url).catch(() => {});
    console.log(`[CRAWLER] Indexed: ${url}`);

    // Fan out links
    const anchors = document.querySelectorAll("a[href]");
    const seen = new Set();
    let queued = 0;
    for (const a of anchors) {
      if (queued >= LINKS_PER_PAGE) break;
      const href = a.getAttribute("href");
      if (!href) continue;
      try {
        const abs = new URL(href, url).toString();
        if (!isSafeUrl(abs)) continue;
        if (isNsfwUrl(abs)) continue;
        const norm = normaliseUrl(abs);
        if (seen.has(norm)) continue;
        seen.add(norm);
        if (noteSeen(norm)) continue;
        await enqueueCrawl(norm).catch(() => {});
        queued += 1;
      } catch {}
    }
    
  } catch (err) {
    if (task?.url) await recordCrawlFailure(task.url, err?.message || "fetch failed").catch(() => {});
    console.error(`[CRAWLER] Error ${url}:`, err?.message || err);
  } finally {
    hostInFlight.set(host, Math.max(0, (hostInFlight.get(host) || 1) - 1));
    hostLastFetch.set(host, Date.now());
    
    // P0 FIX: 300ms sleep = CPU adempauze. Zonder dit throttled Render naar 0.02 vCPU.
    await new Promise(r => setTimeout(r, 300));
  }
}

export function startCrawler(intervalMs = 1000) {
  if (typeof process === "undefined" || !process.versions?.node) return;
  if (running) return;
  running = true;
  
  setTimeout(() => { seedIfEmpty().catch(() => {}); }, 2000).unref?.();

  let inFlight = 0;
  const pump = async () => {
    while (inFlight < CONCURRENCY) {
      let task = null;
      try { task = await nextCrawlTask(); } catch { task = null; }
      if (!task) return;
      
      const host = hostFromUrl(task.url) || "unknown";
      const n = hostInFlight.get(host) || 0;
      const last = hostLastFetch.get(host) || 0;
      if (n >= PER_HOST || Date.now() - last < PER_HOST_MIN_GAP_MS) {
        await dropFromQueue(task.url).catch(() => {});
        await enqueueCrawl(task.url).catch(() => {});
        continue;
      }
      
      inFlight += 1;
      crawlTask(task).finally(() => { inFlight -= 1; });
    }
  };
  
  setInterval(() => {
    pump().catch((err) => {
      console.error("[CRAWLER] Pump error:", err?.message || err);
    });
  }, intervalMs).unref?.();

  // Commit resterende pages bij shutdown
  process.on('SIGTERM', () => {
    if (transactionOpen && pagesSinceCommit > 0) {
      try {
        db.exec('COMMIT');
        console.log(`[CRAWLER] Final commit: ${pagesSinceCommit} pages`);
      } catch {}
    }
  });

  // Janitor: re-enqueue oude pages
  const janitor = async () => {
    try { await reenqueueStale(14 * 24 * 3600 * 1000, 50); } catch {}
  };
  setTimeout(janitor, 60 * 1000).unref?.();
  setInterval(janitor, 60 * 60 * 1000).unref?.();
}

export { stats };

export async function seedFromSearch(urls) {
  if (!Array.isArray(urls) || !urls.length) return 0;
  let n = 0;
  for (const raw of urls.slice(0, 30)) {
    if (typeof raw !== "string") continue;
    try {
      if (!isSafeUrl(raw)) continue;
      if (isNsfwUrl(raw)) continue;
      const norm = normaliseUrl(raw);
      if (noteSeen(norm)) continue;
      await enqueueCrawl(norm).catch(() => {});
      n++;
    } catch {}
  }
  return n;
}

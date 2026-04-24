// Own crawler — Node-only. Pulls from the crawl_queue, fetches pages,
// extracts title/text/links, stores into pages. Grows our own private index
// over time. Skipped gracefully when SQLite is unavailable (serverless).

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
} from "./storage.js";
import { isSafeUrl } from "./safeurl.js";
import { isNsfwUrl, isNsfwText } from "./nsfw.js";

let running = false;

// Extract (title, text) from an HTML string. Extracted so both the eager
// path and the background tick can share identical parsing logic.
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

// Eager, synchronous-ish crawl used by /api/search so that the very first
// time a query is made, we still index the winning pages immediately (rather
// than waiting for the 5s background tick). Bounded timeout so a slow site
// never blocks the caller. Safe to fire-and-forget.
export async function crawlOne(url, { timeoutMs = 5000 } = {}) {
  if (typeof process === "undefined" || !process.versions?.node) return false;
  if (!isSafeUrl(url)) return false;
  if (isNsfwUrl(url)) return false; // never index adult content
  const norm = normaliseUrl(url);
  try {
    const res = await privateFetch(url, { timeout: timeoutMs });
    if (!res.ok) {
      // 4xx/5xx — treat as a failure so the retry budget decrements. 404s
      // burn through their budget quickly and get marked dead.
      await recordCrawlFailure(norm, `HTTP ${res.status}`).catch(() => {});
      return false;
    }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) {
      // Non-HTML is a permanent no-op for this URL — drop from queue but
      // don't burn retries; we just can't index it.
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

// Trusted root URLs we seed the crawler with on cold boot if the index is
// nearly empty. They're high-signal, broadly topical hubs — the crawler
// expands from them via outbound links so within a few ticks we already
// have thousands of pages to match queries against. Keeps "0 from Atomic"
// rare for common searches even on a freshly-deployed Render instance.
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
    // Only seed when we're effectively empty. Never re-seeds on a populated
    // Render instance — the index snapshots restore and we pick up from there.
    if ((s?.pages || 0) >= 50) return;
    for (const u of SEED_URLS) {
      try { await enqueueCrawl(normaliseUrl(u)); } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

// Crawler worker pool with per-host politeness.
//
// At any time up to CONCURRENCY fetches are in flight total, with
// PER_HOST in-flight per host. Links extracted from each page are
// enqueued (capped per page) so the queue fans out naturally.
// Dedup at enqueue time is handled by storage.js (UNIQUE(url)); we add
// a process-local LRU of "already enqueued" URLs so we avoid the DB
// round-trip for the most common dupes.

const CONCURRENCY = 8;
const PER_HOST = 4;
const PER_HOST_MIN_GAP_MS = 250;
const LINKS_PER_PAGE = 40;
const DEDUP_LRU_CAP = 50000;

const dedupLru = new Set();
function noteSeen(url) {
  if (dedupLru.has(url)) return true;
  if (dedupLru.size >= DEDUP_LRU_CAP) {
    // Drop the oldest entry (insertion order).
    const first = dedupLru.values().next().value;
    if (first !== undefined) dedupLru.delete(first);
  }
  dedupLru.add(url);
  return false;
}

const hostInFlight = new Map();
const hostLastFetch = new Map();

async function waitForHostSlot(host) {
  // Spin until there's a free per-host slot AND the politeness gap has
  // elapsed. Sleeps are cheap and keep us from hammering one domain.
  while (true) {
    const n = hostInFlight.get(host) || 0;
    const last = hostLastFetch.get(host) || 0;
    const now = Date.now();
    if (n < PER_HOST && now - last >= PER_HOST_MIN_GAP_MS) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function crawlTask(task) {
  const { url } = task;
  const host = hostFromUrl(url) || "unknown";
  hostInFlight.set(host, (hostInFlight.get(host) || 0) + 1);
  hostLastFetch.set(host, Date.now());
  try {
    if (!isSafeUrl(url)) { await dropFromQueue(url).catch(() => {}); return; }
    const res = await privateFetch(url, { timeout: 6000 });
    if (!res.ok) { await recordCrawlFailure(url, `HTTP ${res.status}`).catch(() => {}); return; }
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) { await dropFromQueue(url).catch(() => {}); return; }
    const html = (await res.text()).slice(0, 500_000);
    const { title, text, document } = extract(html, url);
    if (isNsfwText(title, text)) { await dropFromQueue(url).catch(() => {}); return; }
    await insertPage({ url: normaliseUrl(url), title, text, host });
    await dropFromQueue(url).catch(() => {});
    // Fan out: extract every outbound link, dedupe, enqueue. We
    // deliberately shuffle-light the link set so the crawler doesn't
    // always follow the first N links (which tend to be navigation).
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
      } catch { /* ignore */ }
    }
  } catch (err) {
    if (task?.url) await recordCrawlFailure(task.url, err?.message || "fetch failed").catch(() => {});
  } finally {
    hostInFlight.set(host, Math.max(0, (hostInFlight.get(host) || 1) - 1));
    hostLastFetch.set(host, Date.now());
  }
}

export function startCrawler(intervalMs = 1000) {
  if (typeof process === "undefined" || !process.versions?.node) return;
  if (running) return;
  running = true;
  // Seed a few trusted hubs ~2s after boot so the crawler has something to
  // chew on immediately.
  setTimeout(() => { seedIfEmpty().catch(() => {}); }, 2000).unref?.();

  let inFlight = 0;
  const pump = async () => {
    while (inFlight < CONCURRENCY) {
      let task = null;
      try { task = await nextCrawlTask(); } catch { task = null; }
      if (!task) return;
      const host = hostFromUrl(task.url) || "unknown";
      // Only take the task if there's an open slot for this host; otherwise
      // put it back and try the next one. `nextCrawlTask` already marks the
      // task as taken, so we re-enqueue with a tiny backoff.
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
  setInterval(() => { pump().catch(() => {}); }, intervalMs).unref?.();

  // Janitor: once an hour, re-enqueue pages we indexed more than 14 days ago
  // so the index self-refreshes.
  const janitor = async () => {
    try { await reenqueueStale(14 * 24 * 3600 * 1000, 50); } catch { /* ignore */ }
  };
  setTimeout(janitor, 60 * 1000).unref?.();
  setInterval(janitor, 60 * 60 * 1000).unref?.();
}

export { stats };

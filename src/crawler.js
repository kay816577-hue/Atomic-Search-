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

export function startCrawler(intervalMs = 5000) {
  if (typeof process === "undefined" || !process.versions?.node) return;
  if (running) return;
  running = true;
  const tick = async () => {
    let task = null;
    try {
      task = await nextCrawlTask();
      if (!task) return;
      const { url } = task;
      if (!isSafeUrl(url)) { await dropFromQueue(url); return; }
      const res = await privateFetch(url, { timeout: 8000 });
      if (!res.ok) {
        await recordCrawlFailure(url, `HTTP ${res.status}`);
        return;
      }
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/html")) { await dropFromQueue(url); return; }
      const html = (await res.text()).slice(0, 500_000);
      const { title, text, document } = extract(html, url);
      // Content-level NSFW check — some benign-looking URLs host adult
      // content. Drop without indexing if title or extracted text trips.
      if (isNsfwText(title, text)) { await dropFromQueue(url); return; }
      const host = hostFromUrl(url);
      await insertPage({ url: normaliseUrl(url), title, text, host });
      await dropFromQueue(url);
      let queued = 0;
      for (const a of document.querySelectorAll("a[href]")) {
        if (queued >= 20) break;
        const href = a.getAttribute("href");
        if (!href) continue;
        try {
          const abs = new URL(href, url).toString();
          if (!isSafeUrl(abs)) continue;
          if (isNsfwUrl(abs)) continue;
          await enqueueCrawl(normaliseUrl(abs));
          queued++;
        } catch { /* ignore */ }
      }
    } catch (err) {
      if (task?.url) await recordCrawlFailure(task.url, err?.message || "fetch failed").catch(() => {});
    }
  };
  setInterval(tick, intervalMs).unref?.();

  // Janitor: once an hour, re-enqueue pages we indexed more than 14 days ago
  // so the index self-refreshes. Also prunes dead URLs by virtue of
  // recordCrawlFailure tipping them over the retry budget. Fire once at
  // boot to catch very stale rows, then on a slow interval.
  const janitor = async () => {
    try { await reenqueueStale(14 * 24 * 3600 * 1000, 25); } catch { /* ignore */ }
  };
  setTimeout(janitor, 60 * 1000).unref?.();
  setInterval(janitor, 60 * 60 * 1000).unref?.();
}

export { stats };

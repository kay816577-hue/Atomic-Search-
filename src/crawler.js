// Own crawler — Node-only. Pulls from the crawl_queue, fetches pages,
// extracts title/text/links, stores into pages. Grows our own private index
// over time. Skipped gracefully when SQLite is unavailable (serverless).

import { parseHTML } from "linkedom";
import { privateFetch, hostFromUrl, normaliseUrl, stripTags } from "./util.js";
import { insertPage, nextCrawlTask, enqueueCrawl, stats } from "./storage.js";
import { isSafeUrl } from "./safeurl.js";

let running = false;

// Eager, synchronous-ish crawl used by /api/search so that the very first
// time a query is made, we still index the winning pages immediately (rather
// than waiting for the 5s background tick). Bounded timeout so a slow site
// never blocks the caller. Safe to fire-and-forget.
export async function crawlOne(url, { timeoutMs = 5000 } = {}) {
  if (typeof process === "undefined" || !process.versions?.node) return false;
  if (!isSafeUrl(url)) return false;
  try {
    const res = await privateFetch(url, { timeout: timeoutMs });
    const ct = res.headers.get("content-type") || "";
    if (!ct.includes("text/html")) return false;
    const html = (await res.text()).slice(0, 500_000);
    const { document } = parseHTML(html);
    const title = stripTags(document.querySelector("title")?.textContent || url);
    const text = stripTags(
      [...document.querySelectorAll("p, h1, h2, h3, li")]
        .slice(0, 80)
        .map((n) => n.textContent)
        .join(" ")
    ).slice(0, 4000);
    const host = hostFromUrl(url);
    await insertPage({ url: normaliseUrl(url), title, text, host });
    return true;
  } catch { return false; }
}

export function startCrawler(intervalMs = 5000) {
  if (typeof process === "undefined" || !process.versions?.node) return;
  if (running) return;
  running = true;
  const tick = async () => {
    try {
      const url = await nextCrawlTask();
      if (!url || !isSafeUrl(url)) return;
      const res = await privateFetch(url, { timeout: 8000 });
      const ct = res.headers.get("content-type") || "";
      if (!ct.includes("text/html")) return;
      const html = (await res.text()).slice(0, 500_000);
      const { document } = parseHTML(html);
      const title = stripTags(document.querySelector("title")?.textContent || url);
      const text = stripTags(
        [...document.querySelectorAll("p, h1, h2, h3, li")]
          .slice(0, 60)
          .map((n) => n.textContent)
          .join(" ")
      ).slice(0, 3000);
      const host = hostFromUrl(url);
      await insertPage({ url: normaliseUrl(url), title, text, host });
      let queued = 0;
      for (const a of document.querySelectorAll("a[href]")) {
        if (queued >= 20) break;
        const href = a.getAttribute("href");
        if (!href) continue;
        try {
          const abs = new URL(href, url).toString();
          if (!isSafeUrl(abs)) continue;
          await enqueueCrawl(normaliseUrl(abs));
          queued++;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  };
  setInterval(tick, intervalMs).unref?.();
}

export { stats };

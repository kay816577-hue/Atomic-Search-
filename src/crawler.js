// Own crawler — Node-only. Pulls from the crawl_queue, fetches pages,
// extracts title/text/links, stores into pages. Grows our own private index
// over time. Skipped gracefully when SQLite is unavailable (serverless).

import { parseHTML } from "linkedom";
import { privateFetch, hostFromUrl, normaliseUrl, stripTags } from "./util.js";
import { insertPage, nextCrawlTask, enqueueCrawl, stats } from "./storage.js";

let running = false;

export function startCrawler(intervalMs = 5000) {
  if (typeof process === "undefined" || !process.versions?.node) return;
  if (running) return;
  running = true;
  const tick = async () => {
    try {
      const url = await nextCrawlTask();
      if (!url) return;
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
          if (!abs.startsWith("http")) continue;
          await enqueueCrawl(normaliseUrl(abs));
          queued++;
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  };
  setInterval(tick, intervalMs).unref?.();
}

export { stats };

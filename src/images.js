// Image search aggregator — DuckDuckGo images (2-step vqd flow) + Bing images.
// Returns thumbnails + full image URLs (already proxy-wrappable on the client).

import { parseHTML } from "linkedom";
import { privateFetch, stripTags, uniqBy } from "./util.js";

async function ddgImages(q) {
  try {
    // Step 1 — fetch a token (vqd).
    const pre = await privateFetch(
      `https://duckduckgo.com/?q=${encodeURIComponent(q)}&iax=images&ia=images`
    );
    const html = await pre.text();
    const m = html.match(/vqd=['"]?(\d+-[\d-]+)['"]?/) || html.match(/vqd=([\d-]+)/);
    if (!m) return [];
    const vqd = m[1];
    const res = await privateFetch(
      `https://duckduckgo.com/i.js?l=wt-wt&o=json&q=${encodeURIComponent(q)}&vqd=${vqd}&f=,,,,,&p=1`,
      { headers: { Accept: "application/json", Referer: "https://duckduckgo.com/" } }
    );
    const data = await res.json().catch(() => ({}));
    return (data.results || []).slice(0, 40).map((r) => ({
      title: stripTags(r.title || ""),
      thumbnail: r.thumbnail,
      image: r.image,
      source: r.url,
      width: r.width,
      height: r.height,
      engine: "duckduckgo",
    }));
  } catch {
    return [];
  }
}

async function bingImages(q) {
  try {
    const res = await privateFetch(
      `https://www.bing.com/images/search?q=${encodeURIComponent(q)}&form=HDRSC2`
    );
    const html = await res.text();
    const { document } = parseHTML(html);
    const out = [];
    for (const el of document.querySelectorAll("a.iusc")) {
      const meta = el.getAttribute("m");
      if (!meta) continue;
      try {
        const j = JSON.parse(meta);
        if (!j.murl) continue;
        out.push({
          title: stripTags(j.t || ""),
          thumbnail: j.turl,
          image: j.murl,
          source: j.purl,
          engine: "bing",
        });
      } catch { /* ignore */ }
      if (out.length >= 40) break;
    }
    return out;
  } catch {
    return [];
  }
}

export async function metaImages(q) {
  if (!q || !q.trim()) return { results: [], query: q };
  const query = q.trim().slice(0, 256);
  const [a, b] = await Promise.all([ddgImages(query), bingImages(query)]);
  const merged = uniqBy([...a, ...b], (r) => r.image).slice(0, 60);
  return { query, results: merged };
}

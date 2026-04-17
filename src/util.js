// Small helpers used across modules. No third-party deps.

const DEFAULT_UA =
  "Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0";

/**
 * fetch with a timeout + spoofed UA + no cookies / referrer.
 * Works on Node (>=18, global fetch), Vercel Edge, and Cloudflare Workers.
 */
export async function privateFetch(url, { timeout = 7000, headers = {}, ...rest } = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      ...rest,
      signal: controller.signal,
      redirect: "follow",
      headers: {
        "User-Agent": DEFAULT_UA,
        "Accept-Language": "en-US,en;q=0.9",
        Accept:
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        ...headers,
      },
    });
    return res;
  } finally {
    clearTimeout(t);
  }
}

export function hostFromUrl(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

export function stripTags(html = "") {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function normaliseUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    // strip the most obvious tracking params
    const junk = [
      "utm_source",
      "utm_medium",
      "utm_campaign",
      "utm_term",
      "utm_content",
      "fbclid",
      "gclid",
      "mc_cid",
      "mc_eid",
      "igshid",
      "ref",
      "ref_src",
    ];
    for (const k of junk) url.searchParams.delete(k);
    return url.toString();
  } catch {
    return u;
  }
}

export function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

export function json(data, init = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow",
      "Referrer-Policy": "no-referrer",
      ...(init.headers || {}),
    },
  });
}

// Tokenise once so scoring is cheap.
export function tokenize(s = "") {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

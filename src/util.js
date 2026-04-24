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

// Broad tracking-param blocklist. Every result URL passes through this
// before being shown to the user, stored in the own-index, or emitted in
// the public v1 API — so Atomic never leaks ad/analytics identifiers
// baked into upstream result links.
const TRACKING_PARAMS_EXACT = new Set([
  "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content",
  "utm_id", "utm_name", "utm_reader", "utm_viz_id",
  "fbclid", "gclid", "yclid", "dclid", "msclkid", "twclid", "ttclid", "li_fat_id",
  "mc_cid", "mc_eid", "igshid", "igsh", "ig_rid",
  "ref", "ref_src", "ref_url", "referrer", "source", "src",
  "spm", "scm", "from", "share_source",
  "_openstat", "yclid", "zanpid", "amp", "_hsmi", "_hsenc",
  "wt_mc", "WT.mc_id", "WT.tsrc",
  "email_source", "email_subject", "CampaignID", "campaign",
  "fb_action_ids", "fb_action_types", "fb_ref", "fb_source",
  "pk_campaign", "pk_kwd", "pk_source", "pk_medium",
  "mtm_source", "mtm_medium", "mtm_campaign", "mtm_keyword", "mtm_cid", "mtm_content",
  "trk", "trkCampaign",
  "oly_anon_id", "oly_enc_id",
  "vero_conv", "vero_id",
  "hsCtaTracking", "__hstc", "__hssc", "__hsfp",
  "_ga", "_gl", "gbraid", "wbraid",
  "s_cid", "s_kwcid",
  "ncid", "cmpid", "CNDID", "icid", "intcmp",
  "mkt_tok", "mkt_tok_e",
]);
const TRACKING_PARAMS_PREFIX = [
  "utm_", "ga_", "_ga_", "_hs", "hs_", "mc_", "mtm_", "pk_", "WT.", "trk_",
];

export function normaliseUrl(u) {
  try {
    const url = new URL(u);
    url.hash = "";
    // Canonicalise host: lowercase + strip www. so kernel.org / www.kernel.org
    // collapse to one key (this is critical for RRF cross-source agreement —
    // without it popular sites get duplicated and lose their boost).
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    // Strip tracking params — both explicit names and anything starting
    // with a known prefix (utm_*, mc_*, mtm_*, etc).
    const toDrop = [];
    for (const k of url.searchParams.keys()) {
      if (TRACKING_PARAMS_EXACT.has(k)) { toDrop.push(k); continue; }
      const lk = k.toLowerCase();
      if (TRACKING_PARAMS_PREFIX.some((p) => lk.startsWith(p.toLowerCase()))) {
        toDrop.push(k);
      }
    }
    for (const k of toDrop) url.searchParams.delete(k);
    // Sort remaining query params alphabetically so the same URL with
    // params in different orders collapses to one key.
    const entries = [...url.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
    url.search = "";
    for (const [k, v] of entries) url.searchParams.append(k, v);
    // Collapse bare trailing slash on root path ("https://host/" -> "https://host").
    if (url.pathname === "/" && !url.search) {
      return url.origin;
    }
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

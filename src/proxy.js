// Anonymising URL proxy. Rewrites links / assets in HTML responses so the
// user's browser never directly contacts the target site. No headers from the
// client are forwarded (no cookies, no referrer, no user-agent leak).

import { privateFetch } from "./util.js";
import { isSafeUrl } from "./safeurl.js";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB safety cap
const PROXY_TIMEOUT_MS = 10000;     // 10 s hard upstream timeout
const MAX_REDIRECTS = 5;            // redirect-chain cap (handled by fetch+loop)

function absolutise(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function wrap(u) {
  return `/proxy?url=${encodeURIComponent(u)}`;
}

function rewriteHtml(html, base) {
  return html
    .replace(/<base\s[^>]*>/gi, "")
    // href="..." / src="..." — both single and double quotes
    .replace(/\b(href|src|action|data-src)=(["'])([^"']+)\2/gi, (m, attr, q, val) => {
      if (/^(javascript:|mailto:|tel:|data:|#)/i.test(val)) return m;
      const abs = absolutise(base, val);
      if (!abs) return m;
      if (attr === "href" || attr === "action") return `${attr}=${q}${wrap(abs)}${q}`;
      return `${attr}=${q}${wrap(abs)}${q}`;
    })
    // srcset
    .replace(/\bsrcset=(["'])([^"']+)\1/gi, (m, q, val) => {
      const out = val
        .split(",")
        .map((part) => {
          const [u, descriptor] = part.trim().split(/\s+/, 2);
          const abs = absolutise(base, u);
          if (!abs) return part;
          return `${wrap(abs)}${descriptor ? " " + descriptor : ""}`;
        })
        .join(", ");
      return `srcset=${q}${out}${q}`;
    });
}

const STRIPPED_REQ_HEADERS = [
  "cookie",
  "authorization",
  "referer",
  "origin",
  "x-forwarded-for",
  "x-real-ip",
  "cf-connecting-ip",
];

export async function proxyHandler(targetUrl) {
  if (!targetUrl || !isSafeUrl(targetUrl)) {
    return new Response("Invalid proxy target", { status: 400 });
  }
  // Extra scheme blocklist — isSafeUrl already forces http(s) but belt-and-
  // braces in case the caller hand-built a URL object.
  if (/^(file|gopher|ftp|dict|ldap|tftp|jar|chrome|view-source|javascript|data|blob):/i.test(targetUrl)) {
    return new Response("Scheme not allowed", { status: 400 });
  }
  // Manual redirect handling so we can enforce a hop cap AND re-run
  // isSafeUrl on every Location target (stops open-redirect SSRF).
  let current = targetUrl;
  let res;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeUrl(current)) {
      return new Response("Redirect target not allowed", { status: 400 });
    }
    try {
      res = await privateFetch(current, {
        timeout: PROXY_TIMEOUT_MS,
        redirect: "manual",
        headers: { "Accept-Encoding": "identity" },
      });
    } catch (e) {
      return new Response("Upstream fetch failed: " + (e?.message || e), {
        status: 502,
      });
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      if (hop === MAX_REDIRECTS) {
        return new Response("Too many redirects", { status: 508 });
      }
      try {
        current = new URL(res.headers.get("location"), current).toString();
        continue;
      } catch {
        return new Response("Bad redirect target", { status: 502 });
      }
    }
    break;
  }

  // Strip upstream cookies + any header that could leak/coerce identity —
  // user stays fully anonymous and the rewritten page can't re-embed itself.
  const STRIPPED_RESP = new Set([
    "set-cookie",
    "set-cookie2",
    "clear-site-data",
    "content-security-policy",
    "content-security-policy-report-only",
    "strict-transport-security",
    "x-frame-options",
    "x-ua-compatible",
    "content-length",
    "content-encoding",
    "alt-svc",
    "accept-ch",
    "critical-ch",
    "permissions-policy",
    "feature-policy",
    "report-to",
    "nel",
    "reporting-endpoints",
  ]);
  const headers = new Headers();
  res.headers.forEach((v, k) => {
    if (STRIPPED_RESP.has(k.toLowerCase())) return;
    headers.set(k, v);
  });
  headers.set("Referrer-Policy", "no-referrer");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");

  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct.includes("text/html")) {
    const reader = res.body?.getReader?.();
    let html = "";
    if (reader) {
      const dec = new TextDecoder();
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > MAX_BYTES) break;
        html += dec.decode(value, { stream: true });
      }
      html += dec.decode();
    } else {
      html = await res.text();
    }
    html = rewriteHtml(html, targetUrl);
    // Inject a minimal anonymising meta tag.
    html = html.replace(
      /<head[^>]*>/i,
      (m) => `${m}<meta name="referrer" content="no-referrer"><meta http-equiv="Content-Security-Policy" content="referrer no-referrer">`
    );
    headers.set("Content-Type", "text/html; charset=utf-8");
    return new Response(html, { status: res.status, headers });
  }

  // Stream other content types through unchanged (images, CSS, JS, PDFs…).
  return new Response(res.body, { status: res.status, headers });
}

export { STRIPPED_REQ_HEADERS };

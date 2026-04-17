// Anonymising URL proxy. Rewrites links / assets in HTML responses so the
// user's browser never directly contacts the target site. No headers from the
// client are forwarded (no cookies, no referrer, no user-agent leak).

import { privateFetch } from "./util.js";
import { isSafeUrl } from "./safeurl.js";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB safety cap

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
  let res;
  try {
    res = await privateFetch(targetUrl, {
      timeout: 12000,
      headers: { "Accept-Encoding": "identity" },
    });
  } catch (e) {
    return new Response("Upstream fetch failed: " + (e?.message || e), {
      status: 502,
    });
  }

  // Strip upstream cookies — user stays fully anonymous.
  const headers = new Headers();
  res.headers.forEach((v, k) => {
    const lk = k.toLowerCase();
    if (lk === "set-cookie" || lk === "content-security-policy" || lk === "strict-transport-security" ||
        lk === "x-frame-options" || lk === "content-length" || lk === "content-encoding") {
      return;
    }
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

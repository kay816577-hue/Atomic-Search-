// Anonymising URL proxy. Rewrites links / assets in HTML responses so the
// user's browser never directly contacts the target site. No headers from the
// client are forwarded (no cookies, no referrer, no user-agent leak).

import { privateFetch } from "./util.js";
import { isSafeUrl } from "./safeurl.js";
import { AD_TRACKER_HOSTS, isBlockedHost, matchBlockedHost } from "./adblock.js";

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB safety cap
const PROXY_TIMEOUT_MS = 10000;     // 10 s hard upstream timeout
const MAX_REDIRECTS = 5;            // redirect-chain cap (handled by fetch+loop)

// Realistic browser UA so sites don't serve us the "please upgrade your
// browser" fallback. We still strip every other client-identifying header.
const UPSTREAM_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

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

// Rewrite any URL attribute. Returns the rewritten URL, or the original
// string if the target host is on the ad/tracker blocklist (so we refuse
// to load it even via our own proxy).
function rewriteUrl(val, base) {
  if (/^(javascript:|mailto:|tel:|data:|blob:|about:|#)/i.test(val)) return val;
  const abs = absolutise(base, val);
  if (!abs) return val;
  if (isBlockedHost(abs)) return "about:blank";
  return wrap(abs);
}

function rewriteSrcset(val, base) {
  return val
    .split(",")
    .map((part) => {
      const trimmed = part.trim();
      if (!trimmed) return part;
      const [u, ...rest] = trimmed.split(/\s+/);
      const rew = rewriteUrl(u, base);
      return rest.length ? `${rew} ${rest.join(" ")}` : rew;
    })
    .join(", ");
}

function rewriteHtml(html, base) {
  let stats = { adsBlocked: 0 };
  const bumpIfBlocked = (v) => {
    try {
      const host = new URL(v, base).hostname;
      if (matchBlockedHost(host)) stats.adsBlocked += 1;
    } catch { /* ignore */ }
  };

  let out = html
    // Drop <base> so our rewrites aren't overridden.
    .replace(/<base\b[^>]*>/gi, "")
    // Drop <meta http-equiv="refresh"> since the auto-redirect target wouldn't
    // go through our proxy.
    .replace(/<meta[^>]+http-equiv=["']?refresh["']?[^>]*>/gi, "")
    // Kill ad-network scripts + iframes entirely by matching on src host.
    .replace(/<(script|iframe|embed|object)\b([^>]*?)\bsrc=(["'])([^"']+)\3([^>]*)>/gi,
      (m, tag, pre, q, src, post) => {
        try {
          const host = new URL(src, base).hostname;
          if (matchBlockedHost(host)) { stats.adsBlocked += 1; return ""; }
        } catch { /* ignore */ }
        const rew = rewriteUrl(src, base);
        return `<${tag}${pre}src=${q}${rew}${q}${post}>`;
      }
    )
    // Generic URL attributes (href, action, data-src, formaction, poster,
    // manifest, ping, cite, longdesc). We skip `src` here because the regex
    // above already rewrote it (with blocklist filtering).
    .replace(/\b(href|action|data-src|formaction|poster|manifest|ping|cite|longdesc|background)=(["'])([^"']+)\2/gi,
      (m, attr, q, val) => {
        bumpIfBlocked(val);
        return `${attr}=${q}${rewriteUrl(val, base)}${q}`;
      }
    )
    // Any remaining src attribute we haven't rewritten yet (audio/video/img).
    .replace(/\bsrc=(["'])([^"']+)\1/gi, (m, q, val) => {
      bumpIfBlocked(val);
      return `src=${q}${rewriteUrl(val, base)}${q}`;
    })
    // srcset
    .replace(/\bsrcset=(["'])([^"']+)\1/gi, (m, q, val) => `srcset=${q}${rewriteSrcset(val, base)}${q}`)
    // CSS url(...) inside <style> blocks. (Styles pulled in via <link
    // rel="stylesheet"> stream through the proxy and get rewritten there.)
    .replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, css) => {
      const rewritten = css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (mm, qq, u) => {
        return `url(${qq}${rewriteUrl(u, base)}${qq})`;
      });
      return `<style${attrs}>${rewritten}</style>`;
    });

  return { html: out, stats };
}

// CSS files streamed through the proxy also need their url() refs rewritten.
function rewriteCss(css, base) {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
    if (/^(data:|blob:|about:)/i.test(u)) return m;
    return `url(${q}${rewriteUrl(u, base)}${q})`;
  });
}

// Runtime shim injected into proxied pages. Reroutes fetch/XHR through our
// proxy so in-page API calls still work (without leaking the user's IP).
// Also surfaces the "ads blocked" counter to the parent frame if we're
// embedded in Safe view. Inlined as a single line so it survives CSP.
function buildRuntimeShim(base, adsBlocked) {
  const script = `
    (function(){
      try {
        var BASE = ${JSON.stringify(base)};
        var PROXY = "/proxy?url=";
        function abs(u){ try { return new URL(u, BASE).toString(); } catch(e){ return u; } }
        function isExt(u){ return typeof u === "string" && /^https?:\\/\\//i.test(u); }
        function wrap(u){ return PROXY + encodeURIComponent(abs(u)); }
        // fetch
        var _fetch = window.fetch;
        if (_fetch) {
          window.fetch = function(input, init){
            try {
              if (typeof input === "string") {
                if (isExt(input) || input.startsWith("/")) input = wrap(abs(input));
              } else if (input && input.url) {
                input = new Request(wrap(abs(input.url)), input);
              }
            } catch(e){}
            return _fetch(input, init);
          };
        }
        // XHR
        var OX = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
        if (OX && OX.open) {
          var _open = OX.open;
          OX.open = function(method, url){
            try {
              if (typeof url === "string" && (isExt(url) || url.startsWith("/"))) {
                url = wrap(abs(url));
              }
            } catch(e){}
            arguments[1] = url;
            return _open.apply(this, arguments);
          };
        }
        // Announce ads-blocked count to the embedder (Safe view).
        try {
          window.parent && window.parent.postMessage(
            { _atomicProxy: true, adsBlocked: ${adsBlocked} },
            "*"
          );
        } catch(e){}
      } catch(e){}
    })();`.replace(/\s+/g, " ");
  return `<script>${script}</script>`;
}

function buildWarningBanner(targetUrl) {
  const host = (() => { try { return new URL(targetUrl).hostname.replace(/^www\./, ""); } catch { return ""; } })();
  return `
<div id="__atomic_proxy_bar" style="position:fixed;top:0;left:0;right:0;z-index:2147483647;background:#111;color:#eee;font:13px/1.5 -apple-system,system-ui,sans-serif;padding:8px 14px;display:flex;gap:10px;align-items:center;border-bottom:2px solid #d5313e;box-shadow:0 2px 10px rgba(0,0,0,.4)">
  <span style="background:#d5313e;color:#fff;padding:2px 8px;border-radius:999px;font-weight:700;font-size:11px">ATOMIC PROXY</span>
  <span style="opacity:.9">Viewing <b>${host}</b> anonymously. Cookies blocked, ads filtered. Verification flows won't work here.</span>
  <span style="flex:1"></span>
  <a href="${targetUrl.replace(/"/g, "&quot;")}" target="_blank" rel="noreferrer noopener" style="color:#ff8a93;text-decoration:underline">Open real link &rarr;</a>
</div>
<style>body{padding-top:44px !important}</style>`;
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

export async function proxyHandler(targetUrl, { safeView = false } = {}) {
  if (!targetUrl || !isSafeUrl(targetUrl)) {
    return new Response("Invalid proxy target", { status: 400 });
  }
  if (/^(file|gopher|ftp|dict|ldap|tftp|jar|chrome|view-source|javascript|data|blob):/i.test(targetUrl)) {
    return new Response("Scheme not allowed", { status: 400 });
  }
  // Ad/tracker host blocklist — refuse the request entirely.
  if (isBlockedHost(targetUrl)) {
    return new Response("", {
      status: 204,
      headers: { "X-Atomic-Blocked": "ad-tracker" },
    });
  }

  // Manual redirect handling so we can enforce a hop cap AND re-run
  // isSafeUrl on every Location target (stops open-redirect SSRF).
  let current = targetUrl;
  let res;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isSafeUrl(current)) {
      return new Response("Redirect target not allowed", { status: 400 });
    }
    if (isBlockedHost(current)) {
      return new Response("", { status: 204, headers: { "X-Atomic-Blocked": "ad-tracker-redirect" } });
    }
    try {
      res = await privateFetch(current, {
        timeout: PROXY_TIMEOUT_MS,
        redirect: "manual",
        headers: {
          "Accept-Encoding": "identity",
          "User-Agent": UPSTREAM_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
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
    const { html: rewritten, stats } = rewriteHtml(html, targetUrl);
    let finalHtml = rewritten;
    // Inject CSP meta + runtime fetch/XHR shim + (optional) warning banner.
    const head = `<meta name="referrer" content="no-referrer">${buildRuntimeShim(targetUrl, stats.adsBlocked)}`;
    if (/<head[^>]*>/i.test(finalHtml)) {
      finalHtml = finalHtml.replace(/<head[^>]*>/i, (m) => `${m}${head}`);
    } else {
      finalHtml = head + finalHtml;
    }
    // Safe-view banner (only when the caller is rendering inside the sandbox
    // modal — the /proxy endpoint flags this with ?sv=1).
    if (safeView) {
      const banner = buildWarningBanner(targetUrl);
      if (/<body[^>]*>/i.test(finalHtml)) {
        finalHtml = finalHtml.replace(/<body[^>]*>/i, (m) => `${m}${banner}`);
      } else {
        finalHtml = banner + finalHtml;
      }
    }
    headers.set("Content-Type", "text/html; charset=utf-8");
    headers.set("X-Atomic-Ads-Blocked", String(stats.adsBlocked));
    return new Response(finalHtml, { status: res.status, headers });
  }

  // CSS: rewrite url() references so fonts/backgrounds also proxy.
  if (ct.includes("text/css")) {
    const css = await res.text();
    headers.set("Content-Type", "text/css; charset=utf-8");
    return new Response(rewriteCss(css, targetUrl), { status: res.status, headers });
  }

  // Stream other content types through unchanged (images, JS, PDFs…).
  return new Response(res.body, { status: res.status, headers });
}

export { STRIPPED_REQ_HEADERS, AD_TRACKER_HOSTS };

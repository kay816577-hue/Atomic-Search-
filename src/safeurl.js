// SSRF guard. Used by both the /proxy endpoint and the crawler so that no
// user-influenced URL (submitted sites, discovered links, raw ?url=…) can
// make our server fetch internal / metadata / loopback resources.

function ipv4InRange(ip, a, b, c, d, maskBits) {
  const parts = ip.split(".").map((x) => parseInt(x, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) return false;
  const ipNum =
    (parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3];
  const baseNum = (a << 24) | (b << 16) | (c << 8) | d;
  const mask = maskBits === 0 ? 0 : (~0 << (32 - maskBits)) >>> 0;
  return (ipNum & mask) === (baseNum & mask);
}

function isPrivateIPv4(ip) {
  if (!/^(\d{1,3})(\.\d{1,3}){3}$/.test(ip)) return false;
  return (
    ipv4InRange(ip, 0, 0, 0, 0, 8) ||         // 0.0.0.0/8
    ipv4InRange(ip, 10, 0, 0, 0, 8) ||        // 10.0.0.0/8
    ipv4InRange(ip, 127, 0, 0, 0, 8) ||       // 127.0.0.0/8
    ipv4InRange(ip, 169, 254, 0, 0, 16) ||    // 169.254.0.0/16 (link-local + metadata)
    ipv4InRange(ip, 172, 16, 0, 0, 12) ||     // 172.16.0.0/12
    ipv4InRange(ip, 192, 0, 0, 0, 24) ||      // 192.0.0.0/24
    ipv4InRange(ip, 192, 168, 0, 0, 16) ||    // 192.168.0.0/16
    ipv4InRange(ip, 198, 18, 0, 0, 15) ||     // benchmarking
    ipv4InRange(ip, 224, 0, 0, 0, 4) ||       // multicast
    ipv4InRange(ip, 240, 0, 0, 0, 4)          // reserved
  );
}

function isPrivateIPv6(ip) {
  const h = ip.toLowerCase();
  if (h === "::" || h === "::1") return true;
  if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true; // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true; // unique local fc00::/7
  // IPv4-mapped IPv6: ::ffff:10.0.0.1
  const mapped = h.match(/^::ffff:([0-9a-f.:]+)$/i);
  if (mapped) {
    const tail = mapped[1];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(tail)) return isPrivateIPv4(tail);
  }
  return false;
}

/**
 * Returns true if the URL is safe to fetch on behalf of the user.
 * Blocks non-http(s), internal hostnames, RFC1918 IPv4, IPv6 loopback/ULA/
 * link-local, cloud metadata, and non-standard ports <1024 that aren't
 * 80/443/8080/8443.
 */
export function isSafeUrl(u) {
  if (!u || typeof u !== "string") return false;
  let url;
  try { url = new URL(u); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol)) return false;

  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) return false;
  if (
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host === "ip6-localhost" ||
    host === "ip6-loopback"
  ) return false;
  if (host.endsWith(".internal") || host.endsWith(".local") || host.endsWith(".localhost")) return false;
  if (host === "metadata.google.internal") return false;

  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (isPrivateIPv4(host)) return false;
  }
  // IPv6 literal (bracketed was stripped above)
  if (host.includes(":")) {
    if (isPrivateIPv6(host)) return false;
  }

  // Reject weird ports except the common HTTP ones.
  if (url.port) {
    const p = Number(url.port);
    if (!Number.isFinite(p) || p < 1 || p > 65535) return false;
    const allowed = new Set([80, 443, 8080, 8443, 8000, 8888, 3000, 5000]);
    if (!allowed.has(p)) return false;
  }
  return true;
}

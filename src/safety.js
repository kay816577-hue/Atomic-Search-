// VirusTotal-based URL safety check. Used by the /go interstitial so that
// every outbound click can be risk-rated before the user leaves. Designed to
// gracefully degrade: when no VT key is configured, or when the free-tier
// quota is exhausted, the endpoint returns a neutral "unknown" verdict and
// lets the click proceed.
//
// We only send the URL to VirusTotal — never any user-identifying data — and
// we cache verdicts for 24h so repeated clicks on the same result don't
// burn quota.

import { cacheGet, cacheSet } from "./storage.js";

const VT_API = "https://www.virustotal.com/api/v3";
const VERDICT_TTL = 24 * 60 * 60 * 1000; // 24h

function getKey() {
  if (typeof process === "undefined") return "";
  return process.env?.VIRUSTOTAL_API_KEY || process.env?.VT_API_KEY || "";
}

// URL-safe base64 without padding — VT's ID format for /urls.
function vtUrlId(url) {
  let b64;
  if (typeof Buffer !== "undefined") {
    b64 = Buffer.from(url, "utf8").toString("base64");
  } else {
    b64 = btoa(url);
  }
  return b64.replace(/=+$/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function summarise(stats, source) {
  const s = stats || {};
  const malicious = s.malicious || 0;
  const suspicious = s.suspicious || 0;
  const harmless = s.harmless || 0;
  const undetected = s.undetected || 0;
  const total = malicious + suspicious + harmless + undetected;
  let verdict = "clean";
  if (malicious > 0) verdict = "malicious";
  else if (suspicious > 1) verdict = "suspicious";
  else if (total === 0) verdict = "unknown";
  return { verdict, malicious, suspicious, harmless, undetected, total, source };
}

async function vtLookup(url, key) {
  const id = vtUrlId(url);
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  try {
    // Existing analysis (no quota cost if cached server-side by VT).
    const res = await fetch(`${VT_API}/urls/${id}`, {
      headers: { "x-apikey": key, Accept: "application/json" },
      signal: controller.signal,
    });
    if (res.status === 404) return { status: "not_found" };
    if (res.status === 401 || res.status === 403) return { status: "auth" };
    if (res.status === 429) return { status: "quota" };
    if (!res.ok) return { status: "error" };
    const data = await res.json().catch(() => null);
    const stats = data?.data?.attributes?.last_analysis_stats;
    if (!stats) return { status: "incomplete" };
    return { status: "ok", summary: summarise(stats, "virustotal") };
  } catch {
    return { status: "error" };
  } finally {
    clearTimeout(t);
  }
}

async function vtSubmit(url, key) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 6000);
  try {
    const body = new URLSearchParams({ url }).toString();
    const res = await fetch(`${VT_API}/urls`, {
      method: "POST",
      headers: {
        "x-apikey": key,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
      signal: controller.signal,
    });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Check a URL's safety. Never throws. Always returns an object. Verdict can
 * be: "clean", "suspicious", "malicious", "unknown", "unscanned", "error".
 */
export async function safetyCheck(url) {
  if (!url) return { verdict: "unknown", source: "none" };
  const cacheKey = `safety:${url}`;
  const cached = await cacheGet(cacheKey);
  if (cached) return cached;

  const key = getKey();
  if (!key) {
    const out = { verdict: "unscanned", source: "none", reason: "no-api-key" };
    await cacheSet(cacheKey, out, 60 * 1000);
    return out;
  }

  const r = await vtLookup(url, key);
  if (r.status === "ok") {
    await cacheSet(cacheKey, r.summary, VERDICT_TTL);
    return r.summary;
  }
  if (r.status === "auth") {
    const out = { verdict: "unscanned", source: "none", reason: "bad-key" };
    await cacheSet(cacheKey, out, VERDICT_TTL);
    return out;
  }
  if (r.status === "quota") {
    return { verdict: "unknown", source: "none", reason: "quota-exhausted" };
  }
  if (r.status === "not_found") {
    // Submit for analysis so the next click (or a retry in a moment) has
    // data — but don't block on it.
    vtSubmit(url, key).catch(() => {});
    const out = { verdict: "unknown", source: "virustotal", reason: "queued" };
    await cacheSet(cacheKey, out, 5 * 60 * 1000);
    return out;
  }
  return { verdict: "unknown", source: "none", reason: "error" };
}

// Download safety scanner — given a URL, fetch it, hash it, and ask VirusTotal
// whether they've seen the file. If not, submit it for analysis and poll the
// analysis endpoint for a short budget. Designed to run on Render/Node. Uses
// the same VIRUSTOTAL_API_KEY as URL safety checks.
//
// This is intentionally conservative:
//   - refuses non-safe URLs (via isSafeUrl)
//   - hard cap on download size (20 MiB by default)
//   - hard timeout on VT polls so we never hang a request
//   - never writes the file to disk — we hash in memory

import { createHash } from "node:crypto";
import { privateFetch } from "./util.js";
import { isSafeUrl } from "./safeurl.js";

const MAX_BYTES = 20 * 1024 * 1024; // 20 MiB
const POLL_BUDGET_MS = 20 * 1000;
const POLL_INTERVAL_MS = 2500;

// Hardcoded VirusTotal fallback so the Scan tab works out of the box on any
// deploy without env config. Env var (`VIRUSTOTAL_API_KEY`) always wins.
// Kept in sync with safety.js — rotate in both places after your first deploy.
const VT_FALLBACK_KEY = "4e713f00d6eac72ddf450e4759992687e9f1f8584905625a46828a8e16d9c8fd";

function vtKey() {
  if (typeof process === "undefined") return VT_FALLBACK_KEY;
  return process.env?.VIRUSTOTAL_API_KEY || process.env?.VT_API_KEY || VT_FALLBACK_KEY;
}

async function fetchBytes(url) {
  const res = await privateFetch(url, { timeout: 15000 });
  if (!res.ok) throw new Error("download-failed: HTTP " + res.status);
  const reader = res.body?.getReader ? res.body.getReader() : null;
  if (!reader) {
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error("file-too-large");
    return buf;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      try { await reader.cancel(); } catch { /* ignore */ }
      throw new Error("file-too-large");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

function hashes(buf) {
  return {
    md5: createHash("md5").update(buf).digest("hex"),
    sha1: createHash("sha1").update(buf).digest("hex"),
    sha256: createHash("sha256").update(buf).digest("hex"),
  };
}

function summarise(stats) {
  if (!stats) return { verdict: "unknown" };
  const malicious = stats.malicious || 0;
  const suspicious = stats.suspicious || 0;
  const harmless = stats.harmless || 0;
  const undetected = stats.undetected || 0;
  let verdict = "clean";
  if (malicious >= 1) verdict = "malicious";
  else if (suspicious >= 1) verdict = "suspicious";
  return { verdict, malicious, suspicious, harmless, undetected };
}

async function vtFileLookup(sha256) {
  const key = vtKey();
  if (!key) return null;
  const res = await privateFetch("https://www.virustotal.com/api/v3/files/" + sha256, {
    headers: { "x-apikey": key },
    timeout: 12000,
  });
  if (res.status === 404) return { status: "unknown" };
  if (!res.ok) return { status: "vt-error", code: res.status };
  const data = await res.json().catch(() => ({}));
  const stats = data?.data?.attributes?.last_analysis_stats;
  return {
    status: "known",
    ...summarise(stats),
    permalink: "https://www.virustotal.com/gui/file/" + sha256,
  };
}

async function vtSubmit(buf, name) {
  const key = vtKey();
  if (!key) return null;
  const form = new FormData();
  form.append("file", new Blob([buf]), name || "download.bin");
  const res = await privateFetch("https://www.virustotal.com/api/v3/files", {
    method: "POST",
    headers: { "x-apikey": key },
    body: form,
    timeout: 20000,
  });
  if (!res.ok) return { status: "submit-error", code: res.status };
  const data = await res.json().catch(() => ({}));
  return { status: "queued", analysisId: data?.data?.id };
}

async function vtPollAnalysis(analysisId) {
  const key = vtKey();
  const start = Date.now();
  while (Date.now() - start < POLL_BUDGET_MS) {
    const res = await privateFetch("https://www.virustotal.com/api/v3/analyses/" + analysisId, {
      headers: { "x-apikey": key },
      timeout: 10000,
    });
    if (res.ok) {
      const data = await res.json().catch(() => ({}));
      const status = data?.data?.attributes?.status;
      if (status === "completed") {
        return { status: "completed", ...summarise(data?.data?.attributes?.stats) };
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { status: "pending" };
}

// Scan an arbitrary file buffer via VirusTotal — used by the /api/scan/upload
// endpoint when the user drops a file directly in the Scan tab. Does the same
// hash-first lookup as scanDownload so already-known files return instantly.
export async function scanBuffer(buf, name = "upload.bin") {
  if (!vtKey()) return { ok: false, error: "VirusTotal isn't configured on this server." };
  if (!buf || !buf.length) return { ok: false, error: "empty-file" };
  if (buf.length > MAX_BYTES) return { ok: false, error: "file-too-large" };

  const h = hashes(buf);
  const lookup = await vtFileLookup(h.sha256);
  if (lookup?.status === "known") {
    return { ok: true, hashes: h, size: buf.length, name, ...lookup };
  }
  const submit = await vtSubmit(buf, name);
  if (!submit?.analysisId) {
    return { ok: true, hashes: h, size: buf.length, name, verdict: "unknown", note: "Could not submit to VirusTotal." };
  }
  const analysis = await vtPollAnalysis(submit.analysisId);
  return { ok: true, hashes: h, size: buf.length, name, ...analysis };
}

export async function scanDownload(url) {
  if (!vtKey()) return { ok: false, error: "VirusTotal isn't configured on this server." };
  if (!isSafeUrl(url)) return { ok: false, error: "URL is not allowed." };

  let buf;
  try {
    buf = await fetchBytes(url);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
  if (!buf.length) return { ok: false, error: "empty-file" };

  const h = hashes(buf);
  const lookup = await vtFileLookup(h.sha256);
  if (lookup?.status === "known") {
    return { ok: true, hashes: h, size: buf.length, ...lookup };
  }

  const submit = await vtSubmit(buf, url.split("/").pop() || "download.bin");
  if (!submit?.analysisId) {
    return { ok: true, hashes: h, size: buf.length, verdict: "unknown", note: "Could not submit to VirusTotal." };
  }
  const analysis = await vtPollAnalysis(submit.analysisId);
  return { ok: true, hashes: h, size: buf.length, ...analysis, permalink: "https://www.virustotal.com/gui/file/" + h.sha256 };
}

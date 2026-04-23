#!/usr/bin/env node
/*
 * Maintainer script — downloads the latest public URLhaus malware domains
 * and Steven Black adult hosts, prints a dedup'd JS snippet you can paste
 * into src/nsfw.js (MALWARE_DOMAINS + BLOCKED_DOMAINS). Kept as a manual
 * script so the Render free-tier process doesn't do 5 MB downloads on
 * every restart.
 *
 * Usage: node scripts/refresh-blocklists.mjs
 */
async function fetchText(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.text();
}

function dedupe(arr) {
  return Array.from(new Set(arr)).sort();
}

async function urlhausMalware() {
  const txt = await fetchText("https://urlhaus.abuse.ch/downloads/hostfile/");
  return txt
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.trim().split(/\s+/).pop())
    .filter((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h));
}

async function stevenBlackAdult() {
  // Steven Black's unified hosts with alternative "adult" list.
  const url =
    "https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/porn-only/hosts";
  const txt = await fetchText(url);
  return txt
    .split(/\r?\n/)
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.trim().split(/\s+/)[1])
    .filter((h) => h && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h));
}

const [mal, adult] = await Promise.all([
  urlhausMalware().catch(() => []),
  stevenBlackAdult().catch(() => []),
]);

const malList = dedupe(mal).slice(0, 4000);
const adultList = dedupe(adult).slice(0, 8000);

console.log(`// ${malList.length} malware domains`);
console.log("const MALWARE_DOMAINS = new Set([");
for (const h of malList) console.log(`  "${h}",`);
console.log("]);");
console.log();
console.log(`// ${adultList.length} adult domains`);
console.log("const BLOCKED_DOMAINS = new Set([");
for (const h of adultList) console.log(`  "${h}",`);
console.log("]);");

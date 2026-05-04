// src/ranking.js — v6 Google-like scoring
// Exports: rank, buildQueryContext

const STOPWORDS = new Set([
  "the","a","an","and","or","but","if","then","else","when","at","from","by","on","off","over",
  "to","of","in","for","with","as","is","are","was","were","be","been","being","it","this","that",
  "these","those","i","you","he","she","we","they","them","his","her","their","my","our","your",
  "not","no","do","does","did","doing","can","could","should","would","will","just","than","too",
  "very","so","such","how","what","where","why","who","whom","which"
]);

export function buildQueryContext(q) {
  const raw = (q || "").toLowerCase().trim();
  const tokens = raw
   .replace(/[^\p{L}\p{N}\s]/gu, " ")
   .split(/\s+/)
   .filter(t => t && t.length >= 2 &&!STOPWORDS.has(t));
  const bigrams = [];
  for (let i = 0; i < tokens.length - 1; i++) bigrams.push(tokens[i] + " " + tokens[i + 1]);
  const trigrams = [];
  for (let i = 0; i < tokens.length - 2; i++) trigrams.push(tokens[i] + " " + tokens[i + 1] + " " + tokens[i + 2]);
  return { raw, tokens, bigrams, trigrams };
}

function domainFromUrl(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

function domainRoot(host) {
  const parts = (host || "").split(".");
  return parts.length <= 2? host : parts.slice(-2).join(".");
}

function scoreProximity(ctx, text) {
  if (!ctx.tokens.length) return 0;
  const t = text.toLowerCase();
  let s = 0;
  for (const tri of ctx.trigrams) if (t.includes(tri)) s += 12;
  for (const bi of ctx.bigrams) if (t.includes(bi)) s += 6;
  for (const tok of ctx.tokens) if (t.includes(tok)) s += 2;
  if (t.startsWith(ctx.raw)) s += 10;
  return s;
}

function scoreFreshness(item) {
  const d = item.datePublished || item.date || null;
  if (!d) return 0;
  const ts = Date.parse(d);
  if (isNaN(ts)) return 0;
  const days = (Date.now() - ts) / 86400000;
  if (days < 7) return 8;
  if (days < 30) return 5;
  if (days < 180) return 3;
  if (days < 365) return 1;
  return 0;
}

function scoreAuthority(url, authorityTier = {}) {
  const host = domainFromUrl(url);
  const root = domainRoot(host);
  return authorityTier[host] || authorityTier[root] || 0;
}

function scoreConsensus(item, nEngines = {}) {
  const host = domainFromUrl(item.url);
  const root = domainRoot(host);
  const n = nEngines[host] || nEngines[root] || 1;
  if (n >= 4) return 8;
  if (n === 3) return 5;
  if (n === 2) return 3;
  return 0;
}

function scoreTitleQuality(title, ctx) {
  if (!title) return 0;
  let s = 0;
  const len = title.length;
  if (len >= 15 && len <= 80) s += 3;
  if (len > 100) s -= 2;
  const lower = title.toLowerCase();
  if (ctx.tokens.every(t => lower.includes(t))) s += 4;
  if (/[\u4E00-\u9FFF]/.test(title) &&!/[a-z]{4}/i.test(title)) s -= 6;
  if (/^home$|^index$|^untitled/i.test(title)) s -= 4;
  return s;
}

function scoreSnippetQuality(snippet, ctx) {
  if (!snippet) return -1;
  let s = 0;
  const len = snippet.length;
  if (len >= 60 && len <= 320) s += 2;
  if (len < 30) s -= 2;
  const hits = ctx.tokens.reduce((n, t) => n + (snippet.toLowerCase().includes(t)? 1 : 0), 0);
  s += Math.min(6, hits * 2);
  return s;
}

function penalizeSpam(item) {
  const url = item.url || "";
  const title = item.title || "";
  let p = 0;
  if (/\.ru\/|\.cn\/|blogspot\.[a-z.]+/.test(url)) p -= 2;
  if (/(top 10|you won't believe|secret trick|buy now|cheap|casino|porn)/i.test(title)) p -= 6;
  if (/\?gclid=|\?utm_/.test(url)) p -= 1;
  return p;
}

export function rank(query, items, opts = {}) {
  const ctx = buildQueryContext(query);
  const authorityTier = opts.authorityTier || {};
  const nEngines = opts.nEngines || {};

  const withScore = items.map(it => {
    const title = it.title || "";
    const snippet = it.snippet || it.text || "";
    const text = title + " " + snippet;
    const prox = scoreProximity(ctx, text);
    const fresh = scoreFreshness(it);
    const auth = scoreAuthority(it.url, authorityTier) * 4;
    const cons = scoreConsensus(it, nEngines);
    const tq = scoreTitleQuality(title, ctx);
    const sq = scoreSnippetQuality(snippet, ctx);
    const spam = penalizeSpam(it);
    const own = it.ownIndex? 12 : 0;

    const score = prox + fresh + auth + cons + tq + sq + spam + own;
    return {...it, score, _dbg: { prox, fresh, auth, cons, tq, sq, spam, own } };
  });

  withScore.sort((a, b) => {
    if (b.score!== a.score) return b.score - a.score;
    const da = Date.parse(a.datePublished || a.date || 0) || 0;
    const db = Date.parse(b.datePublished || b.date || 0) || 0;
    if (db!== da) return db - da;
    return (a.url || "").length - (b.url || "").length;
  });

  return withScore;
}

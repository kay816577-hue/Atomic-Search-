// src/ranking.js — v6 Google-like without SEO spam
// Goal: Relevance + Authority + Freshness. No EMD/keyword spam hacks.
// Every signal 0..1. Weights sum to 1. Transparent math.

export const WEIGHTS = Object.freeze({
  relevance: 0.45,    // BM25 + phrase proximity + title intent
  authority: 0.25,    // Host tier + HTTPS + link signals
  freshness: 0.15,    // Recency boost for newsy queries
  quality: 0.10,      // Content depth, structure, not-parked
  agreement: 0.05,    // Cross-engine consensus
});

// Known parked/ad-heavy domains. Hard penalty, not soft demote.
const PARKED_HOSTS = new Set([
  "example.com","example.org","example.net",
  "sedoparking.com","parking-page.com","domainmarket.com",
  "hugedomains.com","buydomains.com","dan.com",
  "ww1.godaddy.com","parking.namebright.com"
]);

// Authority tiers. Tier 3 = wikipedia/github/mdn tier. Tier 0 = unknown.
// Inject from aggregator.js based on your POPULAR_HOSTS list.
export function authorityScore(tier, url) {
  const t = Number(tier) || 0;
  let score = t >= 3 ? 1.0 : t === 2 ? 0.6 : t === 1 ? 0.3 : 0.0;
  
  try {
    const u = new URL(url);
    // HTTPS bonus. HTTP = spam signal.
    if (u.protocol === "https:") score = Math.min(1, score + 0.1);
    // .edu/.gov = instant authority
    if (/\.(edu|gov)(\.|$)/i.test(u.hostname)) score = 1.0;
  } catch {}
  
  return score;
}

const STOPWORDS = new Set([
  "the","a","an","of","is","are","to","in","on","for","and","or","by","at",
  "as","this","that","with","from","it","be","was","were","what","who","how"
]);

// Aggressive suffix strip. We rank content, not domain names.
const TITLE_SUFFIX_RE = /\s*[|\-–—·:]\s*(wikipedia|wiki|mdn|github|docs|documentation|official|home|blog|youtube|reddit)\s*$/i;

export function stripTitleBrand(t) {
  return (t || "").replace(TITLE_SUFFIX_RE, "").trim();
}

export function tokenise(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(t => t.length >= 2 && !STOPWORDS.has(t));
}

export function buildQueryContext(query) {
  const tokens = tokenise(query);
  const isQuestion = /^(who|what|when|where|why|how|does|is|can)\b/i.test(query);
  const isNewsy = /\b(latest|news|today|2024|2025|2026|update|release)\b/i.test(query);
  return {
    raw: (query || "").trim(),
    tokens,
    tokenSet: new Set(tokens),
    isQuestion,
    isNewsy,
    phrase: tokens.join(" ")
  };
}

// ---- RELEVANCE SIGNAL ----
// BM25 + proximity + exact intent. No EMD boost. No keyword density spam.
const BM25_K1 = 1.2;
const BM25_B = 0.75;

function termFreq(text, token) {
  if (!text || !token) return 0;
  const re = new RegExp(`\\b${escapeRe(token)}\\b`, "gi");
  return (text.match(re) || []).length;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bm25Saturation(tf, docLen, avgDocLen) {
  const numerator = tf * (BM25_K1 + 1);
  const denominator = tf + BM25_K1 * (1 - BM25_B + BM25_B * (docLen / avgDocLen));
  return numerator / denominator;
}

// Proximity: tokens close together = higher intent match
function proximityScore(text, tokens) {
  if (tokens.length < 2 || !text) return 0;
  const positions = [];
  for (const t of tokens) {
    const idx = text.indexOf(t);
    if (idx === -1) return 0; // all tokens must exist
    positions.push(idx);
  }
  positions.sort((a, b) => a - b);
  const span = positions[positions.length - 1] - positions[0];
  if (span <= 50) return 1.0;
  if (span >= 400) return 0.0;
  return 1 - (span - 50) / 350;
}

export function relevanceScore(item, ctx) {
  const tokens = ctx.tokens;
  if (!tokens.length) return 0;
  
  const title = stripTitleBrand((item.title || "").toLowerCase());
  const text = (item.snippet || item.text || "").toLowerCase();
  const docLen = title.split(/\s+/).length + text.split(/\s+/).length;
  const avgDocLen = 600; // Tuned for web pages
  
  // 1. BM25 core
  let bm25Sum = 0;
  let titleHits = 0;
  for (const t of tokens) {
    const tfTitle = termFreq(title, t) * 3; // Title 3x weight
    const tfText = termFreq(text, t);
    const tf = tfTitle + tfText;
    bm25Sum += bm25Saturation(tf, docLen, avgDocLen);
    if (tfTitle > 0) titleHits++;
  }
  const bm25 = bm25Sum / (tokens.length * 4); // Normalize
  
  // 2. Phrase match bonus. Exact phrase in title = strong intent.
  let phraseBonus = 0;
  if (ctx.phrase.length >= 4) {
    if (title === ctx.phrase) phraseBonus = 1.0;
    else if (title.startsWith(ctx.phrase)) phraseBonus = 0.7;
    else if (title.includes(ctx.phrase)) phraseBonus = 0.5;
    else if (text.includes(ctx.phrase)) phraseBonus = 0.3;
  }
  
  // 3. Proximity in snippet
  const prox = proximityScore(text, tokens) * 0.5;
  
  // 4. Title coverage: all query tokens in title = canonical result
  const titleCoverage = titleHits / tokens.length;
  
  // Combine: BM25 base + intent bonuses
  const score = bm25 * 0.5 + phraseBonus * 0.3 + prox * 0.1 + titleCoverage * 0.1;
  return clamp01(score);
}

// ---- FRESHNESS SIGNAL ----
// Boost recent docs for newsy queries. Decay over 90 days.
export function freshnessScore(item, ctx) {
  const ageMs = Date.now() - (item.indexed_at || 0);
  const ageDays = ageMs / (24 * 3600 * 1000);
  
  if (ageDays < 1) return 1.0;
  if (ageDays < 7) return 0.8;
  if (ageDays < 30) return 0.5;
  if (ageDays < 90) return 0.2;
  
  // For newsy queries, old = penalty. For evergreen, neutral.
  if (ctx.isNewsy && ageDays > 30) return 0.0;
  return 0.1; // Old but not penalized for evergreen topics
}

// ---- QUALITY SIGNAL ----
// Penalize thin/parked. Reward depth + structure.
export function qualityScore(item) {
  let score = 0.5; // baseline
  
  const text = item.text || item.snippet || "";
  const title = item.title || "";
  
  // 1. Content depth
  const words = text.split(/\s+/).length;
  if (words < 50) score -= 0.4; // Thin content
  else if (words > 300) score += 0.2; // Substantial
  
  // 2. Parked domain check
  try {
    const host = new URL(item.url).hostname.replace(/^www\./, "");
    if (PARKED_HOSTS.has(host)) return 0.0; // Instant kill
  } catch {}
  
  // 3. Title quality: not empty, not just "Home", not clickbait caps
  if (!title || /^home$/i.test(title.trim())) score -= 0.3;
  if (title === title.toUpperCase() && title.length > 10) score -= 0.2; // CLICKBAIT
  
  // 4. URL structure: homepage or clean path > deep tracking URLs
  try {
    const u = new URL(item.url);
    const path = u.pathname;
    if (path === "/" || path === "") score += 0.1;
    if (/\/(tag|category|page\/\d+)/i.test(path)) score -= 0.1; // Pagination/archive
    if (u.search.length > 100) score -= 0.2; // UTM spam
  } catch {}
  
  return clamp01(score);
}

// ---- AGREEMENT SIGNAL ----
// 1 engine = 0. 2 = 0.5. 4+ = 1.0. Log scale.
export function agreementScore(nEngines) {
  const n = Math.max(1, Number(nEngines) || 1);
  if (n <= 1) return 0.0;
  return clamp01(Math.log2(n) / 2);
}

// ---- MAIN COMBINE ----
export function combineScore(item, ctx, signals) {
  const relevance = relevanceScore(item, ctx);
  const authority = authorityScore(signals.authorityTier || 0, item.url);
  const freshness = freshnessScore(item, ctx);
  const quality = qualityScore(item);
  const agreement = agreementScore(signals.nEngines || 1);
  
  // Weighted sum
  let total = 
    WEIGHTS.relevance * relevance +
    WEIGHTS.authority * authority +
    WEIGHTS.freshness * freshness +
    WEIGHTS.quality * quality +
    WEIGHTS.agreement * agreement;
  
  // Hard penalties last
  if (quality === 0) return 0; // Parked domain = dead
  
  return clamp01(total);
}

// Export for aggregator.js
export function rank(query, docs, signals = {}) {
  const ctx = buildQueryContext(query);
  
  // P0 FIX: Pre-filter + cap at 200 docs to prevent CPU spike
  const queryTokens = ctx.tokens;
  const prefiltered = docs.filter(doc => {
    const text = (doc.title + " " + (doc.text || doc.snippet || "")).toLowerCase();
    return queryTokens.some(t => text.includes(t));
  }).slice(0, 200);
  
  const scored = prefiltered.map(doc => {
    const docSignals = {
      authorityTier: signals.authorityTier?.[doc.host] || 0,
      nEngines: signals.nEngines?.[doc.url] || 1
    };
    const score = combineScore(doc, ctx, docSignals);
    return { ...doc, score, _debug: { relevance: relevanceScore(doc, ctx) } };
  });
  
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

function clamp01(x) {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// AI mode — extractive summary over aggregated results, plus optional calls
// to open-source LLMs via HuggingFace Inference API or any OpenAI-compatible
// endpoint (Ollama, LM Studio, together.ai, groq…). Zero-knowledge by default:
// no key set → we still produce a useful extractive answer.
//
// The extractive path is designed to ALWAYS return a non-empty answer as long
// as there are search results. Even if snippets are empty (some engines return
// barely any text), we fall back to a titles-based summary.

import { privateFetch, tokenize } from "./util.js";

function overlap(a, b) {
  const sa = new Set(a);
  let k = 0;
  for (const w of b) if (sa.has(w)) k++;
  return k;
}

// Strip boilerplate that clogs extractive answers — nav menus, cookie
// banners, "sign in", pagination, etc. These are substring checks (cheap).
const BOILERPLATE_RE = /\b(cookie|privacy policy|terms of service|sign (?:in|up)|log ?in|subscribe|newsletter|all rights reserved|copyright ©|toggle navigation|skip to (?:main )?content|menu|home\s*›|jump to|read more|click here)\b/i;

function sentencesFrom(text) {
  return (text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => {
      if (s.length < 30 || s.length > 280) return false;
      // Must end with terminal punctuation (real sentence, not a fragment).
      if (!/[.!?]$/.test(s)) return false;
      // Must start with a letter (skip "· " and bullets).
      if (!/^[A-Z0-9"']/.test(s)) return false;
      // Heuristic: reject nav/boilerplate.
      if (BOILERPLATE_RE.test(s)) return false;
      // Reject sentences with too many pipe/slash separators (menus).
      if ((s.match(/[|›»]/g) || []).length >= 2) return false;
      return true;
    });
}

// Normalize a sentence so near-duplicates collapse: lowercase, strip
// non-alphanum, collapse whitespace. Used for dedup only.
function dedupKey(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

export function extractiveSummary(query, results, maxSentences = 5) {
  const qTokens = tokenize(query);
  const sentences = [];
  for (const r of results.slice(0, 12)) {
    const text = `${r.title || ""}. ${r.snippet || ""}`;
    for (const s of sentencesFrom(text)) {
      const score = overlap(qTokens, tokenize(s));
      sentences.push({ s, score, host: r.host, url: r.url });
    }
  }
  // Prefer relevance, but don't drop sentences with zero overlap — snippets
  // often still describe the topic with synonyms.
  sentences.sort((a, b) => b.score - a.score);
  const picked = [];
  const seen = new Set();
  for (const x of sentences) {
    const key = x.s.slice(0, 80).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(x);
    if (picked.length >= maxSentences) break;
  }
  return picked;
}

function titlesSummary(query, results, maxItems = 5) {
  return results
    .slice(0, maxItems)
    .map((r) => ({
      s: `${r.title || r.host || r.url}`,
      host: r.host,
      url: r.url,
    }));
}

function env(name) {
  if (typeof process !== "undefined" && process.env && process.env[name]) return process.env[name];
  try {
    if (typeof globalThis !== "undefined" && globalThis[name]) return globalThis[name];
  } catch { /* ignore */ }
  return undefined;
}

async function callHuggingFace(prompt) {
  const token = env("HF_API_TOKEN");
  if (!token) return null;
  const model = env("HF_MODEL") || "HuggingFaceH4/zephyr-7b-beta";
  const res = await privateFetch(
    `https://api-inference.huggingface.co/models/${model.trim().replace(/^\/+|\/+$/g, "")}`,
    {
      method: "POST",
      timeout: 15000,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        inputs: prompt,
        parameters: { max_new_tokens: 300, temperature: 0.3, return_full_text: false },
      }),
    }
  );
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data) return null;
  if (Array.isArray(data) && data[0]?.generated_text) return data[0].generated_text.trim();
  if (typeof data.generated_text === "string") return data.generated_text.trim();
  return null;
}

async function callOpenAICompatible(prompt) {
  const base = env("OPENAI_BASE_URL");
  const key = env("OPENAI_API_KEY");
  if (!base) return null;
  const model = env("OPENAI_MODEL") || "llama3";
  const res = await privateFetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    timeout: 15000,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify({
      model,
      temperature: 0.3,
      messages: [
        {
          role: "system",
          content:
            "You are Atomic Search's concise answer engine. Use the provided snippets to answer the user's question in 3-5 sentences. Always cite sources as [n] where n is the result index.",
        },
        { role: "user", content: prompt },
      ],
    }),
  });
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  return data?.choices?.[0]?.message?.content?.trim() || null;
}

function buildPrompt(query, results) {
  const lines = results.slice(0, 8).map(
    (r, i) => `[${i + 1}] ${r.title} — ${r.host}\n${(r.snippet || "").slice(0, 240)}`
  );
  return `Question: ${query}\n\nSources:\n${lines.join("\n\n")}\n\nAnswer concisely, citing sources like [1], [2].`;
}

// Race a promise against a timeout, resolving to null rather than throwing.
function withTimeout(p, ms) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, ms);
    Promise.resolve(p)
      .then((v) => { if (!done) { done = true; clearTimeout(t); resolve(v); } })
      .catch(() => { if (!done) { done = true; clearTimeout(t); resolve(null); } });
  });
}

// Synthesise a coherent prose answer from the highest-relevance sentences in
// the aggregated results. Prefers own-index rows (full body text) over meta
// snippets (truncated to ~240 chars). Drops boilerplate, near-duplicates, and
// sentences that don't actually reference the query.
function synthesise(query, results) {
  const qTokens = tokenize(query);
  const qSet = new Set(qTokens);
  const pool = [];
  const wikiHosts = new Set();

  for (const r of results.slice(0, 20)) {
    const body = r.text || r.snippet || "";
    // Title is often a clean, high-signal sentence on its own; append period
    // so `sentencesFrom` accepts it.
    const titleSentence = r.title && !/[.!?]$/.test(r.title) ? `${r.title}.` : (r.title || "");
    const text = `${titleSentence} ${body}`;
    const isWiki = /wikipedia\.org/.test(r.host || r.url || "");
    if (isWiki) wikiHosts.add(r.host);
    for (const s of sentencesFrom(text)) {
      const tokens = tokenize(s);
      const hits = overlap(qTokens, tokens);
      // Reject sentences with zero query-word overlap — they're probably
      // unrelated boilerplate (e.g. "Download the app now.").
      if (hits === 0) continue;
      let score = hits * 2;
      if (r.ownIndex) score += 1;            // prefer our scraped body text
      if (isWiki) score += 3;                 // Wikipedia sentences are gold
      if (qTokens.every((t) => tokens.includes(t))) score += 2; // all terms present
      pool.push({ s, score, host: r.host, url: r.url, ownIndex: !!r.ownIndex, isWiki });
    }
  }
  pool.sort((a, b) => b.score - a.score);

  // Pick up to 3 sentences, deduped by normalised key AND by prefix overlap
  // so "Hono - Web framework…" + "Hono Web application framework…" collapse.
  const picked = [];
  const seen = new Set();
  for (const x of pool) {
    const key = dedupKey(x.s);
    if (!key) continue;
    if (seen.has(key)) continue;
    // Prefix-overlap guard — drop if the first 25 chars already appeared.
    const prefix = key.slice(0, 25);
    let dup = false;
    for (const k of seen) if (k.startsWith(prefix) || prefix.startsWith(k.slice(0, 25))) { dup = true; break; }
    if (dup) continue;
    seen.add(key);
    picked.push(x);
    if (picked.length >= 3) break;
  }
  if (!picked.length) return null;

  // Build source list + cite each sentence.
  const sourceIndex = new Map();
  const sources = [];
  for (const p of picked) {
    if (!sourceIndex.has(p.url)) {
      sourceIndex.set(p.url, sources.length + 1);
      sources.push({ n: sources.length + 1, title: p.host, url: p.url, host: p.host });
    }
  }
  const prose = picked
    .map((p) => {
      const trimmed = p.s.replace(/\s+$/g, "").replace(/[.!?]+$/, "");
      return `${trimmed} [${sourceIndex.get(p.url)}].`;
    })
    .join(" ");
  return { answer: prose, sources };
}

export async function aiAnswer(query, results) {
  const baseSources = results.slice(0, 8).map((r, i) => ({
    n: i + 1,
    title: r.title,
    url: r.url,
    host: r.host,
  }));

  // Try open-source LLMs with a hard 12-second cap so the extractive path
  // kicks in fast when a model is slow or unavailable.
  const prompt = buildPrompt(query, results);
  const llm = await withTimeout(
    (async () => {
      return (await callOpenAICompatible(prompt)) || (await callHuggingFace(prompt));
    })(),
    12000
  );
  if (llm) return { query, mode: "llm", answer: llm, sources: baseSources };

  // No LLM — produce a real synthesised answer from the top snippets.
  const synth = synthesise(query, results);
  if (synth) {
    return {
      query,
      mode: "synthesis",
      answer: synth.answer,
      sources: synth.sources.length ? synth.sources : baseSources,
    };
  }

  // Last resort — titles-only when everything else is empty.
  const titles = titlesSummary(query, results, 5);
  if (titles.length) {
    const answer = `Based on the top results, ${titles
      .map((t) => t.s)
      .join("; ")}.`;
    return { query, mode: "synthesis", answer, sources: baseSources };
  }

  return {
    query,
    mode: "synthesis",
    answer: `No strong signal found for "${query}". Try rephrasing.`,
    sources: baseSources,
  };
}

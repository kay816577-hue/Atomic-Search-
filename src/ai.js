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

function sentencesFrom(text) {
  return (text || "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 20 && s.length <= 320);
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

export async function aiAnswer(query, results) {
  const sources = results.slice(0, 8).map((r, i) => ({
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

  let extract = extractiveSummary(query, results, 5);
  if (extract.length < 2) {
    // Fallback: use titles when snippets are sparse — guarantees non-empty.
    extract = titlesSummary(query, results, 5);
  }
  const bullets = extract.map((s) => `• ${s.s}${s.host ? "  (" + s.host + ")" : ""}`);
  const fallback = bullets.length
    ? `Here's what the top sources say about "${query}":\n\n${bullets.join("\n")}`
    : `No strong signal found for "${query}". Try rephrasing or switching tabs.`;

  return {
    query,
    mode: llm ? "llm" : "extractive",
    answer: llm || fallback,
    sources,
  };
}

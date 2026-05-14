// Client-side AI mode: lazy-loads @xenova/transformers from jsdelivr,
// runs a small instruct model (Qwen2.5-0.5B-Instruct, INT4/Q4) entirely
// in the browser. Grounds answers on the current result snippets.
//
// Strict constraints:
//   - Off by default. Toggle in Settings ("setting-ai") enables it.
//   - Never runs on page load. Only runs when user clicks "Ask AI" and
//     confirms the download prompt.
//   - Cached forever after first download (service worker + browser cache).
//   - No network calls beyond the model download + tokenizer fetch.
//   - Falls back gracefully if WebGPU/WebAssembly fails (shows error,
//     does not crash page).

(function () {
  "use strict";

  const KEY_ENABLED = "atomic:ai:enabled";
  // Using a very small model so the download is bearable and inference
  // fits in <300MB RAM on a modest laptop.
  const MODEL_ID = "Xenova/Qwen2.5-0.5B-Instruct";

  let pipelinePromise = null;   // lazy-init
  let currentResults = [];      // set by AtomicResults (search page)
  let isGenerating = false;

  function isEnabled() {
    try { return localStorage.getItem(KEY_ENABLED) === "1"; } catch { return false; }
  }

  function setEnabled(v) {
    try { localStorage.setItem(KEY_ENABLED, v ? "1" : "0"); } catch { /* ignore */ }
  }

  async function loadPipeline(onStatus) {
    if (pipelinePromise) return pipelinePromise;

    pipelinePromise = (async () => {
      onStatus && onStatus("Loading transformers.js…");
      const mod = await import(
        "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2/+esm"
      );
      const { pipeline, env } = mod;
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      onStatus && onStatus("Downloading model (~180 MB, cached forever)…");

      const gen = await pipeline("text-generation", MODEL_ID, {
        quantized: true,
        progress_callback: (p) => {
          if (p?.status === "progress" && p.file && p.progress != null) {
            const pct = Math.round(p.progress);
            onStatus && onStatus(`Downloading ${p.file}: ${pct}%`);
          }
        },
      });

      onStatus && onStatus("Model ready.");
      return gen;
    })().catch((err) => {
      pipelinePromise = null;
      onStatus && onStatus(`Failed: ${err?.message || "unknown error"}`);
      throw err;
    });

    return pipelinePromise;
  }

  function buildPrompt(question, results) {
    const ctx = (results || []).slice(0, 5).map((r, i) =>
      `[${i + 1}] ${r.title || r.host || ""}\n${(r.snippet || "").slice(0, 300)}`
    ).join("\n\n");
    return (
      "You are a concise search assistant. Use the numbered sources below " +
      "to answer. If the answer is not in the sources, say you don't know.\n\n" +
      "SOURCES:\n" + ctx + "\n\nQUESTION: " + question + "\nANSWER:"
    );
  }

  function renderMsg(role, text) {
    const box = document.getElementById("ai-messages");
    if (!box) return null;
    const div = document.createElement("div");
    div.className = "ai-msg ai-msg-" + role;
    div.textContent = text;
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  async function ask(question) {
    const statusEl = document.getElementById("ai-status");
    const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };

    if (isGenerating) return;
    isGenerating = true;

    renderMsg("user", question);
    const thinking = renderMsg("assistant", "…");

    try {
      const gen = await loadPipeline(setStatus);
      setStatus("Generating…");
      const prompt = buildPrompt(question, currentResults);
      const out = await gen(prompt, {
        max_new_tokens: 220,
        temperature: 0.3,
        do_sample: true,
        return_full_text: false,
      });
      const text = (out?.[0]?.generated_text || "").trim() || "(no answer)";
      if (thinking) thinking.textContent = text;
      setStatus("Ready.");
    } catch (err) {
      if (thinking) thinking.textContent =
        "Error: " + (err?.message || "failed to run model");
    } finally {
      isGenerating = false;
    }
  }

  function openPanel() {
    const m = document.getElementById("ai-modal");
    if (!m) return;
    m.hidden = false;
    document.documentElement.style.overflow = "hidden";
    const input = document.getElementById("ai-input");
    setTimeout(() => input?.focus(), 50);
  }

  function closePanel() {
    const m = document.getElementById("ai-modal");
    if (!m) return;
    m.hidden = true;
    document.documentElement.style.overflow = "";
  }

  function hookSettingToggle() {
    const t = document.getElementById("setting-ai");
    if (!t) return;
    t.checked = isEnabled();
    t.addEventListener("change", () => {
      setEnabled(!!t.checked);
      // Re-render any "Ask AI" CTAs based on new state.
      document.dispatchEvent(new Event("atomic:ai-toggled"));
    });
  }

  function hookFormAndClose() {
    const form = document.getElementById("ai-form");
    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        const input = document.getElementById("ai-input");
        const q = (input?.value || "").trim();
        if (!q) return;
        input.value = "";
        ask(q);
      });
    }
    const modal = document.getElementById("ai-modal");
    if (modal) {
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closePanel();
        if (e.target.closest?.(".modal-close")) closePanel();
      });
    }
  }

  document.addEventListener("DOMContentLoaded", () => {
    hookSettingToggle();
    hookFormAndClose();
  });

  // Expose a small API for features.js / results rendering to add an
  // "Ask AI" button when AI mode is on.
  window.AtomicAI = {
    isEnabled,
    setEnabled,
    openPanel,
    closePanel,
    setResults(list) { currentResults = Array.isArray(list) ? list : []; },
    ask,
  };
})();

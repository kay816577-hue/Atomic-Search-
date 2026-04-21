/*
 * Atomic extras — command palette, voice search, history dropdown,
 * keyboard-shortcut cheatsheet. Deliberately decoupled from app.js so the
 * core search flow stays lean and these feel like progressive enhancements.
 *
 * Stored state:
 *   atomic.history   — JSON array of recent queries (de-duped, max 20).
 */
(function () {
  "use strict";

  var HIST_KEY = "atomic.history";
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list.slice(0, 20))); } catch (e) { /* ignore */ }
  }
  function addHistory(q) {
    q = (q || "").trim();
    if (!q) return;
    var list = loadHistory().filter(function (x) { return x !== q; });
    list.unshift(q);
    saveHistory(list);
  }
  function clearHistory() { saveHistory([]); refreshHistoryDatalist(); }

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  /* ---------- Search-history datalist ----------
     Native <datalist> gives us free browser-native autocomplete with
     keyboard navigation, dismissal on Escape, and styling that matches
     the OS. No custom dropdown code needed. */
  function ensureDatalist() {
    var dl = document.getElementById("atomic-history-dl");
    if (dl) return dl;
    dl = document.createElement("datalist");
    dl.id = "atomic-history-dl";
    document.body.appendChild(dl);
    return dl;
  }
  function refreshHistoryDatalist() {
    var dl = ensureDatalist();
    var list = loadHistory();
    dl.innerHTML = list.map(function (q) { return '<option value="' + esc(q) + '">'; }).join("");
  }
  function attachHistory(input) {
    if (!input) return;
    input.setAttribute("list", "atomic-history-dl");
  }

  /* ---------- Voice search (Web Speech API) ----------
     Progressive enhancement: if the browser supports it, we inject a
     small mic button next to the search input; otherwise we do nothing.
     All speech recognition happens in the browser — no data leaves the
     device. */
  function supportsSpeech() {
    return typeof window !== "undefined" && (
      "SpeechRecognition" in window || "webkitSpeechRecognition" in window
    );
  }
  function makeMicButton(onResult) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn atomic-mic";
    btn.setAttribute("aria-label", "Search with your voice");
    btn.title = "Voice search (in-browser)";
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v4"/></svg>';
    btn.addEventListener("click", function () {
      var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!Rec) return;
      try {
        var rec = new Rec();
        rec.lang = navigator.language || "en-US";
        rec.interimResults = false;
        rec.maxAlternatives = 1;
        btn.classList.add("recording");
        rec.onresult = function (ev) {
          var t = (ev.results && ev.results[0] && ev.results[0][0] && ev.results[0][0].transcript) || "";
          if (t && typeof onResult === "function") onResult(t.trim());
        };
        rec.onend = function () { btn.classList.remove("recording"); };
        rec.onerror = function () { btn.classList.remove("recording"); };
        rec.start();
      } catch (e) { btn.classList.remove("recording"); }
    });
    return btn;
  }
  function wireVoice() {
    if (!supportsSpeech()) return;
    [
      { form: "home-form", input: "q-hero" },
      { form: "form",      input: "q"      },
    ].forEach(function (pair) {
      var form = document.getElementById(pair.form);
      var input = document.getElementById(pair.input);
      if (!form || !input || form.querySelector(".atomic-mic")) return;
      var mic = makeMicButton(function (text) {
        input.value = text;
        if (typeof form.requestSubmit === "function") form.requestSubmit();
        else form.dispatchEvent(new Event("submit", { cancelable: true }));
      });
      // Insert mic right before the submit button so the layout order is
      // [input][mic][search].
      var submit = form.querySelector('button[type="submit"]');
      if (submit) form.insertBefore(mic, submit);
      else form.appendChild(mic);
    });
  }

  /* ---------- Shortcuts cheatsheet ----------
     Press "?" to open a modal listing every keyboard shortcut and
     power-user trick. Pressing "?" or Escape again closes it. */
  var SHORTCUTS = [
    { k: "/",        d: "Focus the search box" },
    { k: "Ctrl+K",   d: "Open the command palette" },
    { k: "?",        d: "Show this cheatsheet" },
    { k: "Esc",      d: "Close any open modal or suggestion list" },
    { k: "site:",    d: "Limit results to a domain, e.g. site:github.com raft" },
    { k: "\"x y\"",  d: "Quoted phrase — require exact phrase match" },
  ];
  function ensureCheatsheet() {
    var modal = document.getElementById("shortcuts-modal");
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "modal-backdrop";
    modal.id = "shortcuts-modal";
    modal.hidden = true;
    modal.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">' +
      '  <header><h2 id="shortcuts-title">Keyboard shortcuts</h2>' +
      '    <button class="icon-btn" data-close-modal aria-label="Close">\u2715</button>' +
      '  </header>' +
      '  <div class="modal-body"><dl class="shortcut-list">' +
      SHORTCUTS.map(function (s) {
        return '<div class="shortcut-row"><dt><kbd>' + esc(s.k) + '</kbd></dt><dd>' + esc(s.d) + '</dd></div>';
      }).join("") +
      '</dl></div></div>';
    document.body.appendChild(modal);
    modal.addEventListener("click", function (e) {
      if (e.target === modal) modal.hidden = true;
      if (e.target && e.target.closest && e.target.closest("[data-close-modal]")) modal.hidden = true;
    });
    return modal;
  }
  function openCheatsheet() { ensureCheatsheet().hidden = false; }
  function closeCheatsheet() { var m = document.getElementById("shortcuts-modal"); if (m) m.hidden = true; }

  /* ---------- Command palette (Ctrl+K / Cmd+K) ----------
     Small overlay with fuzzy-ish match over a static list of actions +
     the user's recent search history. Lets power users jump anywhere
     without a mouse. */
  var ACTIONS = [
    { label: "Search the web",              hint: "run a query", run: function (q) { submitQuery(q || "atomic search"); } },
    { label: "Open settings",                hint: "theme, safety, AI…", run: function () { clickById("open-settings") || clickById("open-settings-home"); } },
    { label: "Submit a URL to index",        hint: "grow the Atomic index", run: function () { clickById("open-submit-home"); } },
    { label: "Open scan tab",                hint: "VirusTotal URL/file scan", run: function () { activateTab("scan"); } },
    { label: "Go home",                      hint: "clear results", run: function () { location.href = "/"; } },
    { label: "Sign in / account",            hint: "optional login", run: function () { clickById("open-auth") || clickById("open-auth-home"); } },
    { label: "Clear search history",         hint: "forget every query on this device", run: function () { clearHistory(); } },
    { label: "Show keyboard shortcuts",      hint: "", run: openCheatsheet },
    { label: "Theme: Quantum",               hint: "switch theme", run: function () { setTheme("quantum"); } },
    { label: "Theme: Synthwave",             hint: "switch theme", run: function () { setTheme("synthwave"); } },
    { label: "Theme: Aurora",                hint: "switch theme", run: function () { setTheme("aurora"); } },
    { label: "Theme: Matrix",                hint: "switch theme", run: function () { setTheme("matrix"); } },
    { label: "Theme: Obsidian",              hint: "switch theme", run: function () { setTheme("obsidian"); } },
    { label: "Theme: Atom Light",            hint: "switch theme", run: function () { setTheme("atom-light"); } },
  ];

  function clickById(id) {
    var el = document.getElementById(id);
    if (el) { el.click(); return true; }
    return false;
  }
  function activateTab(name) {
    var btn = document.querySelector('.tabs button[data-tab="' + name + '"]');
    if (btn) btn.click();
  }
  function setTheme(t) {
    document.body.dataset.theme = t;
    try { localStorage.setItem("atomic.theme", t); } catch (e) { /* ignore */ }
    var sel = document.getElementById("theme");
    if (sel) sel.value = t;
  }
  function submitQuery(q) {
    var input = document.getElementById("q") || document.getElementById("q-hero");
    var form = document.getElementById("home-form") || document.getElementById("form");
    if (!input || !form) return;
    input.value = q;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { cancelable: true }));
  }

  function fuzzyScore(needle, hay) {
    needle = (needle || "").toLowerCase();
    hay = (hay || "").toLowerCase();
    if (!needle) return 1;
    if (hay.indexOf(needle) !== -1) return 5 + (needle.length / Math.max(1, hay.length));
    var i = 0, j = 0, score = 0;
    while (i < needle.length && j < hay.length) {
      if (needle[i] === hay[j]) { score += 1; i += 1; }
      j += 1;
    }
    return i === needle.length ? score / hay.length : 0;
  }
  function rankCommands(q) {
    var items = ACTIONS.map(function (a) {
      return { type: "action", label: a.label, hint: a.hint, run: a.run, score: fuzzyScore(q, a.label + " " + a.hint) };
    });
    loadHistory().forEach(function (h) {
      items.push({ type: "history", label: h, hint: "recent search", run: function () { submitQuery(h); }, score: fuzzyScore(q, h) + 0.5 });
    });
    items = items.filter(function (it) { return !q || it.score > 0; });
    items.sort(function (a, b) { return b.score - a.score; });
    return items.slice(0, 12);
  }

  function ensurePalette() {
    var el = document.getElementById("cmd-palette");
    if (el) return el;
    el = document.createElement("div");
    el.className = "modal-backdrop";
    el.id = "cmd-palette";
    el.hidden = true;
    el.innerHTML =
      '<div class="modal cmd-modal" role="dialog" aria-modal="true" aria-labelledby="cmd-title">' +
      '  <header><h2 id="cmd-title" class="sr-only">Command palette</h2>' +
      '    <input id="cmd-input" class="cmd-input" type="text" placeholder="Search commands, themes, history\u2026" autocomplete="off" />' +
      '    <button class="icon-btn" data-close-modal aria-label="Close">\u2715</button>' +
      '  </header>' +
      '  <ul id="cmd-list" class="cmd-list" role="listbox"></ul>' +
      '</div>';
    document.body.appendChild(el);
    el.addEventListener("click", function (ev) {
      if (ev.target === el) close();
      if (ev.target && ev.target.closest && ev.target.closest("[data-close-modal]")) close();
    });
    return el;

    function close() { el.hidden = true; }
  }
  function renderPaletteList(q) {
    var list = document.getElementById("cmd-list");
    if (!list) return [];
    var items = rankCommands(q || "");
    list.innerHTML = items.map(function (it, i) {
      return '<li role="option" data-idx="' + i + '" class="cmd-row' + (i === 0 ? " active" : "") + '">' +
        '<span class="cmd-label">' + esc(it.label) + '</span>' +
        (it.hint ? '<span class="cmd-hint">' + esc(it.hint) + '</span>' : "") +
        '</li>';
    }).join("") || '<li class="cmd-row empty">No matches.</li>';
    return items;
  }
  function openPalette() {
    var el = ensurePalette();
    el.hidden = false;
    var input = document.getElementById("cmd-input");
    var items = renderPaletteList("");
    var active = 0;
    function pick(i) {
      if (!items[i]) return;
      el.hidden = true;
      try { items[i].run(); } catch (e) { /* ignore */ }
    }
    input.value = "";
    setTimeout(function () { input.focus(); }, 10);
    input.oninput = function () {
      items = renderPaletteList(input.value);
      active = 0;
    };
    input.onkeydown = function (ev) {
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        active = Math.min(active + 1, items.length - 1);
        highlight(active);
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        active = Math.max(active - 1, 0);
        highlight(active);
      } else if (ev.key === "Enter") {
        ev.preventDefault();
        pick(active);
      } else if (ev.key === "Escape") {
        el.hidden = true;
      }
    };
    var list = document.getElementById("cmd-list");
    list.onclick = function (ev) {
      var row = ev.target.closest(".cmd-row");
      if (!row) return;
      var idx = parseInt(row.getAttribute("data-idx") || "-1", 10);
      if (idx >= 0) pick(idx);
    };
    function highlight(i) {
      var rows = list.querySelectorAll(".cmd-row");
      rows.forEach(function (r, idx) { r.classList.toggle("active", idx === i); });
      var row = rows[i];
      if (row && typeof row.scrollIntoView === "function") row.scrollIntoView({ block: "nearest" });
    }
  }

  /* ---------- Result-card bulk actions ----------
     Delegated click handler for the copy-URL button rendered inside each
     result card. One handler covers every result via event delegation. */
  function wireResultActions() {
    document.addEventListener("click", function (ev) {
      var copy = ev.target.closest && ev.target.closest("[data-copy]");
      if (!copy) return;
      ev.preventDefault();
      var url = copy.getAttribute("data-copy") || "";
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(url);
        } else {
          var ta = document.createElement("textarea");
          ta.value = url; document.body.appendChild(ta); ta.select();
          document.execCommand("copy"); ta.remove();
        }
        copy.classList.add("copied");
        setTimeout(function () { copy.classList.remove("copied"); }, 900);
      } catch (e) { /* ignore */ }
    });
  }

  /* ---------- Boot ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    attachHistory(document.getElementById("q-hero"));
    attachHistory(document.getElementById("q"));
    refreshHistoryDatalist();

    // Also refresh the datalist after every form submission so recent
    // queries show up without needing a reload.
    ["home-form", "form"].forEach(function (id) {
      var f = document.getElementById(id);
      if (!f) return;
      f.addEventListener("submit", function () {
        var input = f.querySelector('input[type="search"]');
        if (!input) return;
        setTimeout(function () { addHistory(input.value); refreshHistoryDatalist(); }, 50);
      });
    });

    wireVoice();
    wireResultActions();

    document.addEventListener("keydown", function (e) {
      var tag = (e.target && e.target.tagName || "").toLowerCase();
      var inField = tag === "input" || tag === "textarea" || tag === "select";
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        openPalette();
        return;
      }
      if (e.key === "?" && !inField) {
        e.preventDefault();
        openCheatsheet();
        return;
      }
      if (e.key === "Escape") {
        closeCheatsheet();
        var p = document.getElementById("cmd-palette");
        if (p && !p.hidden) p.hidden = true;
      }
    });
  });
})();

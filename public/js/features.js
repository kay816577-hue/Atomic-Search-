/* Atomic Search — extra client-side features.
 *
 * Everything in this file is localStorage-backed. Nothing ever leaves
 * the browser. No cookies, no server state, no tracking.
 *
 * Features landed here:
 *   - Bangs (!w !g !gh !yt !r !hn !so !a !ddg !b !maps)
 *   - Keyboard shortcuts (/ j k o y b ? Esc Enter)
 *   - Cheatsheet overlay
 *   - Bookmarks (add, list, import/export JSON)
 *   - Search history (add, list, clear, export)
 *   - Voice search (Web Speech API)
 *   - Auto-suggest dropdown (own index + recent)
 *   - Font size + density settings
 *   - Open-links-in-new-tab toggle
 *   - Prefer-own-index / safe-view-default toggles
 */

(function () {
  "use strict";
  var LS = window.localStorage;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  };

  // ---------- Bangs ----------
  var BANGS = {
    w:    function (q) { return "https://en.wikipedia.org/wiki/Special:Search?search=" + encodeURIComponent(q); },
    wiki: function (q) { return "https://en.wikipedia.org/wiki/Special:Search?search=" + encodeURIComponent(q); },
    g:    function (q) { return "https://www.google.com/search?q=" + encodeURIComponent(q); },
    gh:   function (q) { return "https://github.com/search?q=" + encodeURIComponent(q); },
    yt:   function (q) { return "https://www.youtube.com/results?search_query=" + encodeURIComponent(q); },
    r:    function (q) { return "https://www.reddit.com/search/?q=" + encodeURIComponent(q); },
    hn:   function (q) { return "https://hn.algolia.com/?q=" + encodeURIComponent(q); },
    so:   function (q) { return "https://stackoverflow.com/search?q=" + encodeURIComponent(q); },
    a:    function (q) { return "https://web.archive.org/web/*/" + encodeURIComponent(q); },
    ddg:  function (q) { return "https://duckduckgo.com/?q=" + encodeURIComponent(q); },
    b:    function (q) { return "https://www.bing.com/search?q=" + encodeURIComponent(q); },
    maps: function (q) { return "https://www.openstreetmap.org/search?query=" + encodeURIComponent(q); },
    mdn:  function (q) { return "https://developer.mozilla.org/en-US/search?q=" + encodeURIComponent(q); },
    npm:  function (q) { return "https://www.npmjs.com/search?q=" + encodeURIComponent(q); },
    pkg:  function (q) { return "https://pkg.go.dev/search?q=" + encodeURIComponent(q); },
    crates:function (q) { return "https://crates.io/search?q=" + encodeURIComponent(q); },
    arch: function (q) { return "https://wiki.archlinux.org/index.php?search=" + encodeURIComponent(q); },
    tools:function ()  { return "/tools"; },
  };

  function handleBang(raw) {
    var m = String(raw || "").match(/^!([a-z]+)(?:\s+(.+))?$/i);
    if (!m) return null;
    var fn = BANGS[m[1].toLowerCase()];
    if (!fn) return null;
    var rest = (m[2] || "").trim();
    return fn(rest);
  }

  // Intercept form submits for bangs. Uses capture so we see it before
  // app.js's own submitQuery handler.
  function interceptBang(form, input) {
    if (!form || !input) return;
    form.addEventListener("submit", function (e) {
      var url = handleBang(input.value);
      if (!url) return;
      e.preventDefault();
      e.stopPropagation();
      window.open(url, "_blank", "noreferrer,noopener");
    }, true);
  }

  // ---------- Bookmarks ----------
  var BM_KEY = "atomic:bookmarks";
  function bmList() { try { return JSON.parse(LS.getItem(BM_KEY) || "[]"); } catch (e) { return []; } }
  function bmSave(list) { try { LS.setItem(BM_KEY, JSON.stringify(list.slice(0, 2000))); } catch (e) { /* ignore */ } }
  function bmHas(url) { var l = bmList(); for (var i = 0; i < l.length; i++) if (l[i].url === url) return true; return false; }
  function bmToggle(url, title) {
    var list = bmList();
    var idx = -1;
    for (var i = 0; i < list.length; i++) if (list[i].url === url) { idx = i; break; }
    if (idx >= 0) {
      list.splice(idx, 1);
      bmSave(list);
      return false;
    }
    list.unshift({ url: url, title: title || url, at: Date.now() });
    bmSave(list);
    return true;
  }
  function bmExport() {
    var blob = new Blob([JSON.stringify(bmList(), null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atomic-bookmarks-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }
  function bmImport(file) {
    var fr = new FileReader();
    fr.onload = function () {
      try {
        var data = JSON.parse(fr.result);
        if (!Array.isArray(data)) return;
        var existing = bmList();
        var seen = {};
        existing.forEach(function (b) { seen[b.url] = true; });
        data.forEach(function (b) {
          if (b && b.url && !seen[b.url]) { existing.push(b); seen[b.url] = true; }
        });
        bmSave(existing);
        renderBookmarksPanel();
      } catch (e) { /* ignore */ }
    };
    fr.readAsText(file);
  }

  // ---------- Search history ----------
  var HIST_KEY = "atomic:history";
  var HIST_OPT_KEY = "atomic:history-opt";
  function historyEnabled() { return LS.getItem(HIST_OPT_KEY) !== "0"; }
  function setHistoryEnabled(v) { LS.setItem(HIST_OPT_KEY, v ? "1" : "0"); }
  function histList() { try { return JSON.parse(LS.getItem(HIST_KEY) || "[]"); } catch (e) { return []; } }
  function histSave(list) { try { LS.setItem(HIST_KEY, JSON.stringify(list.slice(0, 500))); } catch (e) { /* ignore */ } }
  function histAdd(q) {
    if (!historyEnabled() || !q || q.length < 2 || q.length > 200) return;
    var list = histList().filter(function (x) { return x.q !== q; });
    list.unshift({ q: q, at: Date.now() });
    histSave(list);
  }
  function histClear() { LS.removeItem(HIST_KEY); }
  function histExport() {
    var blob = new Blob([JSON.stringify(histList(), null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atomic-history-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  // ---------- Settings persistence ----------
  var SETTINGS_KEY = "atomic:settings.v2";
  var DEFAULTS = {
    fontSize: "m",        // s | m | l
    density: "comfortable", // compact | comfortable | spacious
    openInNewTab: true,
    safeViewDefault: false,
    preferOwnIndex: false,
    historyEnabled: true,
    autoSuggest: true,
    aiMode: false,        // AI chat mode — opt-in
  };
  function settings() {
    try {
      var s = JSON.parse(LS.getItem(SETTINGS_KEY) || "{}");
      var out = {};
      Object.keys(DEFAULTS).forEach(function (k) { out[k] = (k in s) ? s[k] : DEFAULTS[k]; });
      return out;
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  function saveSettings(s) {
    try { LS.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
    applySettings(s);
  }
  function applySettings(s) {
    s = s || settings();
    document.documentElement.setAttribute("data-font-size", s.fontSize);
    document.documentElement.setAttribute("data-density", s.density);
    document.documentElement.setAttribute("data-new-tab", s.openInNewTab ? "1" : "0");
    setHistoryEnabled(s.historyEnabled);
  }

  // ---------- Voice search ----------
  var Rec = window.SpeechRecognition || window.webkitSpeechRecognition;
  function attachVoice(input, buttonAfter) {
    if (!Rec || !input || !buttonAfter || buttonAfter.parentNode.querySelector(".voice-btn")) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "voice-btn";
    btn.setAttribute("aria-label", "Voice search");
    btn.title = "Voice search";
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M12 1a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10a7 7 0 0 1-14 0M12 19v4M8 23h8"/></svg>';
    buttonAfter.parentNode.insertBefore(btn, buttonAfter);
    btn.addEventListener("click", function () {
      var r = new Rec();
      r.lang = "en-US";
      r.interimResults = false;
      r.continuous = false;
      btn.classList.add("listening");
      r.onresult = function (e) {
        var q = (e.results[0][0].transcript || "").trim();
        if (q) { input.value = q; input.form && input.form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); }
      };
      r.onerror = r.onend = function () { btn.classList.remove("listening"); };
      try { r.start(); } catch (e) { btn.classList.remove("listening"); }
    });
  }

  // ---------- Auto-suggest dropdown ----------
  // Pulls candidates from own-index titles via /api/search?q=... (small
  // debounce). Falls back to recent-history entries when offline.
  function attachAutoSuggest(input, form) {
    if (!input) return;
    var box = document.createElement("div");
    box.className = "atomic-suggest";
    box.setAttribute("role", "listbox");
    box.hidden = true;
    input.parentNode.appendChild(box);
    var t = 0;
    input.addEventListener("input", function () {
      if (!settings().autoSuggest) { box.hidden = true; return; }
      var q = input.value.trim();
      if (q.length < 2 || /^!/.test(q)) { box.hidden = true; return; }
      clearTimeout(t);
      t = setTimeout(function () { suggestFor(q); }, 220);
    });
    input.addEventListener("focus", function () {
      if (input.value.trim().length >= 2) suggestFor(input.value.trim());
    });
    document.addEventListener("click", function (e) {
      if (!box.contains(e.target) && e.target !== input) box.hidden = true;
    });
    input.addEventListener("keydown", function (e) {
      if (box.hidden) return;
      var items = box.querySelectorAll("[role=option]");
      if (!items.length) return;
      var cur = -1;
      for (var i = 0; i < items.length; i++) if (items[i].getAttribute("aria-selected") === "true") { cur = i; break; }
      if (e.key === "ArrowDown") { e.preventDefault(); highlight(items, (cur + 1 + items.length) % items.length); }
      else if (e.key === "ArrowUp") { e.preventDefault(); highlight(items, (cur - 1 + items.length) % items.length); }
      else if (e.key === "Enter" && cur >= 0) { e.preventDefault(); items[cur].click(); }
      else if (e.key === "Escape") { box.hidden = true; }
    });

    function highlight(items, idx) {
      for (var i = 0; i < items.length; i++) items[i].setAttribute("aria-selected", i === idx ? "true" : "false");
    }

    function render(list) {
      if (!list.length) { box.hidden = true; return; }
      box.innerHTML = list.map(function (s, i) {
        return '<div role="option" data-q="' + esc(s.q) + '" aria-selected="' + (i === 0 ? "true" : "false") + '">' +
               '<span class="s-kind">' + esc(s.kind) + '</span><span class="s-text">' + esc(s.q) + '</span></div>';
      }).join("");
      box.hidden = false;
      Array.prototype.forEach.call(box.querySelectorAll("[role=option]"), function (el) {
        el.addEventListener("click", function () {
          input.value = el.getAttribute("data-q");
          box.hidden = true;
          if (form) form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        });
      });
    }

    function suggestFor(q) {
      // Local suggestions from history first — instant.
      var hist = histList()
        .filter(function (h) { return h.q.toLowerCase().indexOf(q.toLowerCase()) === 0; })
        .slice(0, 3)
        .map(function (h) { return { kind: "Recent", q: h.q }; });

      // Own-index titles: piggyback a small /api/search call so we don't
      // need a dedicated endpoint. We only pluck titles from first 6
      // results.
      fetch("/api/search?q=" + encodeURIComponent(q) + "&per_page=6", { credentials: "omit" })
        .then(function (r) { return r.ok ? r.json() : { results: [] }; })
        .then(function (j) {
          var titles = (j.results || [])
            .filter(function (r) { return r.ownIndex; })
            .slice(0, 5)
            .map(function (r) { return { kind: "Index", q: r.title }; });
          render(hist.concat(titles).slice(0, 8));
        })
        .catch(function () { render(hist); });
    }
  }

  // ---------- Keyboard shortcuts ----------
  function installShortcuts() {
    var keys = {};
    document.addEventListener("keydown", function (e) {
      // Ignore if typing in an input / textarea / contenteditable.
      var tgt = e.target;
      var typing = tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA" || tgt.isContentEditable);

      if (!typing && e.key === "/") {
        e.preventDefault();
        var q = $("q") || $("q-hero");
        if (q) { q.focus(); q.select && q.select(); }
        return;
      }
      if (!typing && e.key === "?") {
        e.preventDefault();
        toggleCheatsheet();
        return;
      }
      if (e.key === "Escape") {
        var cs = $("cheatsheet-modal");
        if (cs && !cs.hidden) { cs.hidden = true; return; }
      }
      if (typing) return;
      // Result-list navigation
      if (e.key === "j" || e.key === "k") {
        var list = Array.prototype.slice.call(document.querySelectorAll("#results .result"));
        if (!list.length) return;
        var cur = list.findIndex(function (el) { return el.classList.contains("kbd-active"); });
        list.forEach(function (el) { el.classList.remove("kbd-active"); });
        var next = e.key === "j" ? (cur + 1) % list.length : (cur - 1 + list.length) % list.length;
        var el = list[next];
        el.classList.add("kbd-active");
        el.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
      if (e.key === "Enter") {
        var act = document.querySelector("#results .result.kbd-active .title");
        if (act) { e.preventDefault(); act.click(); }
      }
      if (e.key === "o") {
        // Open top-5 result links in new tabs
        e.preventDefault();
        var top5 = Array.prototype.slice.call(document.querySelectorAll("#results .result .title")).slice(0, 5);
        top5.forEach(function (a) { window.open(a.href, "_blank", "noreferrer,noopener"); });
      }
      if (e.key === "y") {
        // Copy URL of highlighted result
        var u = document.querySelector("#results .result.kbd-active .title");
        if (u) { navigator.clipboard && navigator.clipboard.writeText(u.href); toast("URL copied"); }
      }
      if (e.key === "b") {
        var act2 = document.querySelector("#results .result.kbd-active");
        if (act2) {
          var a = act2.querySelector(".title");
          var added = bmToggle(a.href, a.textContent);
          toast(added ? "Bookmarked" : "Removed bookmark");
          updateBookmarkButtons();
        }
      }
    });
  }

  // Tiny toast util
  var toastTimer = 0;
  function toast(msg) {
    var el = $("atomic-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "atomic-toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 1800);
  }

  // ---------- Cheatsheet modal ----------
  function buildCheatsheet() {
    if ($("cheatsheet-modal")) return;
    var div = document.createElement("div");
    div.id = "cheatsheet-modal";
    div.className = "modal-backdrop";
    div.hidden = true;
    div.setAttribute("role", "dialog");
    div.setAttribute("aria-modal", "true");
    div.innerHTML =
      '<div class="modal">' +
      '  <div class="modal-head">' +
      '    <h2>Keyboard shortcuts &amp; bangs</h2>' +
      '    <button class="icon-btn modal-close" type="button" aria-label="Close">\u2715</button>' +
      '  </div>' +
      '  <div class="modal-body">' +
      '    <h3>Keyboard</h3>' +
      '    <ul class="cheat-list">' +
      '      <li><kbd>/</kbd> focus search</li>' +
      '      <li><kbd>j</kbd> / <kbd>k</kbd> next / prev result</li>' +
      '      <li><kbd>Enter</kbd> open highlighted result</li>' +
      '      <li><kbd>o</kbd> open top 5 results in new tabs</li>' +
      '      <li><kbd>y</kbd> copy highlighted result URL</li>' +
      '      <li><kbd>b</kbd> bookmark / unbookmark highlighted result</li>' +
      '      <li><kbd>?</kbd> show this cheatsheet</li>' +
      '      <li><kbd>Esc</kbd> close</li>' +
      '    </ul>' +
      '    <h3>Bangs</h3>' +
      '    <p class="hint">Start your query with a bang to jump straight to a site.</p>' +
      '    <ul class="cheat-list cheat-bangs">' +
      '      <li><code>!w</code> Wikipedia</li>' +
      '      <li><code>!g</code> Google</li>' +
      '      <li><code>!ddg</code> DuckDuckGo</li>' +
      '      <li><code>!b</code> Bing</li>' +
      '      <li><code>!gh</code> GitHub</li>' +
      '      <li><code>!yt</code> YouTube</li>' +
      '      <li><code>!r</code> Reddit</li>' +
      '      <li><code>!hn</code> Hacker News</li>' +
      '      <li><code>!so</code> Stack Overflow</li>' +
      '      <li><code>!mdn</code> MDN</li>' +
      '      <li><code>!npm</code> npm</li>' +
      '      <li><code>!pkg</code> Go packages</li>' +
      '      <li><code>!crates</code> crates.io</li>' +
      '      <li><code>!arch</code> Arch wiki</li>' +
      '      <li><code>!maps</code> OpenStreetMap</li>' +
      '      <li><code>!a</code> Wayback</li>' +
      '      <li><code>!tools</code> Atomic tools page</li>' +
      '    </ul>' +
      '    <h3>Typed instants</h3>' +
      '    <p class="hint">Type these directly into the search box:</p>' +
      '    <ul class="cheat-list">' +
      '      <li><code>2 + 2</code>, <code>(5*7)-3</code>, <code>15% of 200</code>, <code>sqrt(144)</code></li>' +
      '      <li><code>define serendipity</code></li>' +
      '      <li><code>time in tokyo</code></li>' +
      '      <li><code>weather in berlin</code></li>' +
      '      <li><code>100 km to miles</code>, <code>25 c to f</code>, <code>5 kg to lb</code></li>' +
      '      <li><code>100 usd to eur</code></li>' +
      '      <li><code>roll 2d6</code>, <code>flip coin</code>, <code>random 1 to 100</code></li>' +
      '    </ul>' +
      '  </div>' +
      '</div>';
    document.body.appendChild(div);
    div.addEventListener("click", function (e) {
      if (e.target === div || (e.target.classList && e.target.classList.contains("modal-close"))) div.hidden = true;
    });
  }
  function toggleCheatsheet() {
    buildCheatsheet();
    var m = $("cheatsheet-modal");
    m.hidden = !m.hidden;
  }

  // ---------- Bookmark button on result cards ----------
  function addBookmarkButtons() {
    Array.prototype.forEach.call(document.querySelectorAll("#results .result"), function (card) {
      if (card.querySelector(".bookmark-btn")) return;
      var titleA = card.querySelector(".title");
      if (!titleA) return;
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "bookmark-btn icon-btn";
      btn.title = "Bookmark";
      btn.setAttribute("aria-label", "Bookmark");
      var actionsBar = card.querySelector(".result-actions") || card;
      actionsBar.appendChild(btn);
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        var added = bmToggle(titleA.href, titleA.textContent.trim());
        btn.classList.toggle("on", added);
        toast(added ? "Bookmarked" : "Removed bookmark");
      });
      refreshBtn();
      function refreshBtn() {
        var on = bmHas(titleA.href);
        btn.classList.toggle("on", on);
        btn.innerHTML = on
          ? '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" stroke="currentColor" aria-hidden="true"><path d="M6 2h12v20l-6-4-6 4V2z"/></svg>'
          : '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M6 2h12v20l-6-4-6 4V2z"/></svg>';
      }
    });
  }
  function updateBookmarkButtons() {
    Array.prototype.forEach.call(document.querySelectorAll("#results .result .bookmark-btn"), function (b) {
      var t = b.parentNode.parentNode.querySelector(".title") || b.parentNode.querySelector(".title");
      if (!t) return;
      b.classList.toggle("on", bmHas(t.href));
    });
  }

  // ---------- Bookmarks / History overlay ----------
  function openListModal(kind) {
    var id = "atomic-list-modal";
    var existing = $(id);
    if (existing) existing.remove();
    var div = document.createElement("div");
    div.id = id;
    div.className = "modal-backdrop";
    div.setAttribute("role", "dialog");
    div.setAttribute("aria-modal", "true");
    document.body.appendChild(div);
    div.addEventListener("click", function (e) {
      if (e.target === div || (e.target.classList && e.target.classList.contains("modal-close"))) div.remove();
    });
    renderListInto(div, kind);
  }
  function renderListInto(div, kind) {
    var isBM = kind === "bookmarks";
    var list = isBM ? bmList() : histList();
    var headActions = isBM
      ? '<button class="pill" data-act="import">Import</button>' +
        '<button class="pill" data-act="export">Export</button>'
      : '<button class="pill" data-act="export">Export</button>' +
        '<button class="pill" data-act="clear">Clear all</button>';
    var rows = list.length
      ? list.map(function (it, i) {
          return '<li data-i="' + i + '">' +
            (isBM
              ? '<a href="' + esc(it.url) + '" target="_blank" rel="noreferrer noopener">' + esc(it.title || it.url) + '</a><span class="muted">' + esc(it.url) + '</span>'
              : '<a href="#" data-q="' + esc(it.q) + '" class="hist-item">' + esc(it.q) + '</a><span class="muted">' + new Date(it.at).toLocaleString() + '</span>') +
            '<button class="pill del" data-act="del" title="Remove">&times;</button>' +
            '</li>';
        }).join("")
      : '<li class="muted">Nothing here yet.</li>';
    div.innerHTML =
      '<div class="modal">' +
      '  <div class="modal-head">' +
      '    <h2>' + (isBM ? "Bookmarks" : "Search history") + '</h2>' +
      '    <div class="head-actions">' + headActions + '</div>' +
      '    <button class="icon-btn modal-close" type="button" aria-label="Close">&times;</button>' +
      '  </div>' +
      '  <div class="modal-body">' +
      '    <ul class="atomic-list">' + rows + '</ul>' +
      '  </div>' +
      '</div>';
    div.hidden = false;
    Array.prototype.forEach.call(div.querySelectorAll("[data-act]"), function (b) {
      b.addEventListener("click", function () {
        var act = b.getAttribute("data-act");
        if (act === "export") { isBM ? bmExport() : histExport(); return; }
        if (act === "clear") { if (confirm("Clear all search history?")) { histClear(); renderListInto(div, kind); } return; }
        if (act === "import") {
          var fi = document.createElement("input");
          fi.type = "file"; fi.accept = "application/json";
          fi.onchange = function () { if (fi.files[0]) bmImport(fi.files[0]); setTimeout(function () { renderListInto(div, kind); }, 300); };
          fi.click();
          return;
        }
        if (act === "del") {
          var li = b.parentNode;
          var idx = parseInt(li.getAttribute("data-i"), 10);
          if (isBM) { var l = bmList(); l.splice(idx, 1); bmSave(l); }
          else { var l2 = histList(); l2.splice(idx, 1); histSave(l2); }
          renderListInto(div, kind);
        }
      });
    });
    Array.prototype.forEach.call(div.querySelectorAll(".hist-item"), function (a) {
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var q = a.getAttribute("data-q");
        var inp = $("q") || $("q-hero");
        if (inp) { inp.value = q; inp.form && inp.form.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true })); }
        div.remove();
      });
    });
  }

  // ---------- Home actions: bookmarks / history buttons ----------
  function installHomeActions() {
    var row = document.querySelector(".home-actions");
    if (!row) return;
    if (row.querySelector('[data-home-bm]')) return;
    var b1 = document.createElement("button");
    b1.type = "button"; b1.textContent = "Bookmarks";
    b1.setAttribute("data-home-bm", "1");
    b1.addEventListener("click", function () { openListModal("bookmarks"); });
    var b2 = document.createElement("button");
    b2.type = "button"; b2.textContent = "History";
    b2.addEventListener("click", function () { openListModal("history"); });
    var b3 = document.createElement("button");
    b3.type = "button"; b3.textContent = "Tools";
    b3.addEventListener("click", function () { window.location.href = "/tools"; });
    var b4 = document.createElement("button");
    b4.type = "button"; b4.textContent = "Shortcuts";
    b4.addEventListener("click", function () { toggleCheatsheet(); });
    row.appendChild(b1); row.appendChild(b2); row.appendChild(b3); row.appendChild(b4);
  }

  // ---------- Boot ----------
  function boot() {
    applySettings();
    var homeForm = $("home-form"), homeInput = $("q-hero");
    var searchForm = $("form"), searchInput = $("q");
    interceptBang(homeForm, homeInput);
    interceptBang(searchForm, searchInput);
    if (homeForm) attachVoice(homeInput, homeForm.querySelector("button[type=submit]"));
    if (searchForm) attachVoice(searchInput, searchForm.querySelector("button[type=submit]"));
    if (homeForm) attachAutoSuggest(homeInput, homeForm);
    if (searchForm) attachAutoSuggest(searchInput, searchForm);
    installShortcuts();
    installHomeActions();
    buildCheatsheet();
    // History logging
    window.addEventListener("atomic:search", function (e) {
      if (e.detail && e.detail.q) histAdd(e.detail.q);
    });
    // Bookmark buttons on freshly rendered results
    var results = $("results");
    if (results) {
      var obs = new MutationObserver(function () { addBookmarkButtons(); });
      obs.observe(results, { childList: true, subtree: true });
      addBookmarkButtons();
    }
    // Expose a tiny API for settings UI
    window.AtomicFeatures = {
      settings: settings,
      saveSettings: saveSettings,
      bookmarks: { list: bmList, toggle: bmToggle, has: bmHas, export: bmExport, import: bmImport },
      history: { list: histList, clear: histClear, export: histExport, enabled: historyEnabled, setEnabled: setHistoryEnabled },
      openList: openListModal,
      toggleCheatsheet: toggleCheatsheet,
      toast: toast,
    };
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

(function () {
  "use strict";

  /* ---------------- Settings (localStorage) ---------------- */
  var SETTINGS_KEY = "atomic.settings";
  var defaultSettings = {
    ai: false,
    safety: true,
    proxyLinks: true,
    perPage: 50,
  };
  function loadSettings() {
    try {
      var raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return Object.assign({}, defaultSettings);
      var parsed = JSON.parse(raw);
      return Object.assign({}, defaultSettings, parsed);
    } catch (e) { return Object.assign({}, defaultSettings); }
  }
  function saveSettings(s) {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch (e) { /* ignore */ }
  }
  var settings = loadSettings();

  /* ---------------- Auth state (cookie session) ---------------- */
  var me = null;
  var authConfig = { google: false, email: false };

  /* ---------------- State ---------------- */
  var state = { q: "", tab: "all", page: 1 };

  /* ---------------- Helpers ---------------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function faviconUrl(host) {
    if (!host) return "";
    return "https://www.google.com/s2/favicons?sz=32&domain=" + encodeURIComponent(host);
  }
  function hostOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return ""; }
  }
  function pathOf(url) {
    try {
      var u = new URL(url);
      var p = (u.pathname || "/").replace(/\/+$/, "");
      return (u.hostname.replace(/^www\./, "") + (p ? " › " + p.split("/").filter(Boolean).slice(0, 3).join(" › ") : "")).trim();
    } catch (e) { return url; }
  }
  function linkFor(url) {
    if (settings.proxyLinks) return "/go?url=" + encodeURIComponent(url);
    return url;
  }

  /* ---------------- Views ---------------- */
  function showHome() {
    $("home").hidden = false;
    $("results-shell").hidden = true;
    document.body.dataset.view = "home";
  }
  function showResults() {
    $("home").hidden = true;
    $("results-shell").hidden = false;
    document.body.dataset.view = "results";
  }

  /* ---------------- Search ---------------- */
  function setTab(t) {
    state.tab = t || "all";
    Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) {
      b.classList.toggle("active", b.getAttribute("data-tab") === state.tab);
    });
    $("results").hidden = state.tab !== "all" && state.tab !== "news";
    $("pager").hidden = $("results").hidden;
    $("images-grid").hidden = state.tab !== "images";
    $("ai-full").hidden = state.tab !== "ai";
    $("empty").hidden = true;
    if (!state.q) return;
    if (state.tab === "images") doImages(state.q);
    else if (state.tab === "ai") doAI(state.q);
    else doSearch(state.q);
  }

  async function doSearch(q) {
    state.q = q;
    $("search-meta").hidden = false;
    $("search-meta").innerHTML = '<span><span class="loading"></span>Searching our index…</span>';
    $("empty").hidden = true;
    $("results").innerHTML = "";
    $("pager").hidden = true;

    var u = "/api/search?q=" + encodeURIComponent(q) + "&page=" + state.page + "&per_page=" + settings.perPage;
    var t0 = performance.now();
    var data;
    try {
      var res = await fetch(u);
      data = await res.json();
    } catch (e) {
      $("search-meta").innerHTML = '<span style="color:var(--danger)">Something went wrong. Try again.</span>';
      return;
    }
    var elapsed = ((performance.now() - t0) / 1000).toFixed(2);
    var results = (data && data.results) || [];

    if (!results.length) {
      $("search-meta").hidden = true;
      $("empty").hidden = false;
      return;
    }

    var ownCount = data.ownIndexCount || results.filter(function (r) { return r.ownIndex; }).length;
    $("search-meta").innerHTML =
      "<span>About " + (data.total || results.length) + " results (" + elapsed + "s)</span>" +
      '<span class="dot"></span>' +
      "<span>" + ownCount + " from Atomic index</span>";

    $("results").hidden = false;
    $("results").innerHTML = results.map(renderResult).join("");
    renderPager(data);

    // Lazy-fetch safety verdicts in batches of 10.
    if (settings.safety) lazyLoadSafety(results);
  }

  function renderResult(r, i) {
    var host = r.host || hostOf(r.url);
    var pathLabel = pathOf(r.url);
    var fav = faviconUrl(host);
    var badge = r.ownIndex
      ? '<span class="badge atomic" title="Matched in the Atomic index">Atomic</span>'
      : "";
    return (
      '<article class="result" data-url="' + esc(r.url) + '">' +
      '  <div class="host-line">' +
      '    <span class="fav" style="background-image:url(' + esc(fav) + ')"></span>' +
      '    <div style="display:flex;flex-direction:column;min-width:0;flex:1">' +
      '      <span class="host">' + esc(host) + "</span>" +
      '      <span class="host-url" title="' + esc(r.url) + '">' + esc(pathLabel) + "</span>" +
      "    </div>" +
      "    " + badge +
      '    <span class="safety-dot" data-verdict="pending" title="Scanning for safety…"></span>' +
      "  </div>" +
      '  <a class="title" href="' + esc(linkFor(r.url)) + '" rel="noreferrer noopener" target="_top">' + esc(r.title || r.url) + "</a>" +
      (r.snippet ? '<p class="snippet">' + esc(r.snippet) + "</p>" : "") +
      "</article>"
    );
  }

  function renderPager(data) {
    var pager = $("pager");
    var page = data.page || 1;
    var hasMore = !!data.hasMore;
    pager.hidden = false;
    pager.innerHTML =
      '<button id="prev-page" ' + (page <= 1 ? "disabled" : "") + ">← Previous</button>" +
      '<span class="pager-info">Page ' + page + "</span>" +
      '<button id="next-page" ' + (hasMore ? "" : "disabled") + ">Next →</button>";
    var prev = $("prev-page"), next = $("next-page");
    if (prev) prev.addEventListener("click", function () {
      if (state.page > 1) { state.page--; pushUrl(); doSearch(state.q); }
    });
    if (next) next.addEventListener("click", function () {
      state.page++; pushUrl(); doSearch(state.q);
    });
  }

  async function lazyLoadSafety(results) {
    var urls = results.map(function (r) { return r.url; });
    var chunks = [];
    for (var i = 0; i < urls.length; i += 10) chunks.push(urls.slice(i, i + 10));
    for (var c = 0; c < chunks.length; c++) {
      try {
        var res = await fetch("/api/safety/batch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ urls: chunks[c] }),
        });
        var data = await res.json();
        (data.results || []).forEach(function (x) {
          var cards = document.querySelectorAll('.result[data-url="' + cssEscape(x.url) + '"] .safety-dot');
          cards.forEach(function (dot) {
            dot.setAttribute("data-verdict", x.verdict || "unknown");
            dot.title = verdictLabel(x);
          });
        });
      } catch (e) { /* ignore */ }
    }
  }

  function verdictLabel(x) {
    if (!x) return "Not scanned";
    if (x.verdict === "clean") return "Safe: no antivirus engine flagged this.";
    if (x.verdict === "suspicious") return (x.suspicious || 0) + " engine(s) flagged this as suspicious.";
    if (x.verdict === "malicious") return (x.malicious || 0) + " engine(s) flagged this as malicious.";
    if (x.verdict === "unscanned") return "Safety scanning isn't configured on this server.";
    return "Not yet analysed.";
  }

  function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, "\\$&");
  }

  async function doImages(q) {
    $("images-grid").hidden = false;
    $("images-grid").innerHTML = '<p class="empty"><span class="loading"></span>Loading images…</p>';
    $("results").hidden = true;
    $("pager").hidden = true;
    try {
      var res = await fetch("/api/images?q=" + encodeURIComponent(q));
      var data = await res.json();
      var items = (data && data.results) || [];
      if (!items.length) { $("images-grid").innerHTML = '<p class="empty">No images.</p>'; return; }
      $("images-grid").innerHTML = items.map(function (img) {
        var viewUrl = "/go?url=" + encodeURIComponent(img.source || img.image);
        return (
          '<a href="' + esc(viewUrl) + '" target="_top" rel="noreferrer noopener">' +
          '  <img loading="lazy" src="' + esc(img.thumbnail || img.image) + '" alt="' + esc(img.title || "") + '">' +
          (img.title ? '<span class="caption">' + esc(img.title) + "</span>" : "") +
          "</a>"
        );
      }).join("");
    } catch (e) {
      $("images-grid").innerHTML = '<p class="empty">Could not load images.</p>';
    }
  }

  async function doAI(q) {
    $("ai-full").hidden = false;
    $("results").hidden = true;
    $("pager").hidden = true;
    if (!settings.ai) {
      $("ai-full").innerHTML =
        '<div class="ai-disabled">' +
        '  <h2>AI answers are off</h2>' +
        '  <p>Turn on AI answers in Settings to get a concise summary over the Atomic index for your query.</p>' +
        '  <button id="ai-enable">Enable AI</button>' +
        "</div>";
      var btn = $("ai-enable");
      if (btn) btn.addEventListener("click", function () {
        settings.ai = true;
        saveSettings(settings);
        refreshSettingsUI();
        doAI(q);
      });
      return;
    }
    $("ai-full").innerHTML = '<div class="ai-summary"><div class="ai-head"><span class="ai-badge">AI</span><span class="ai-mode">Thinking…</span></div><p class="ai-text"><span class="loading"></span>Reading top results…</p></div>';
    try {
      var res = await fetch("/api/ai?q=" + encodeURIComponent(q));
      var data = await res.json();
      var srcHTML = (data.sources || []).map(function (s, i) {
        return '<li><a href="' + esc(linkFor(s.url)) + '" target="_top" rel="noreferrer noopener">[' + (i + 1) + '] ' + esc(s.title || s.host) + "</a> — <span class=\"host\">" + esc(s.host) + "</span></li>";
      }).join("");
      $("ai-full").innerHTML =
        '<div class="ai-summary">' +
        '<div class="ai-head"><span class="ai-badge">AI</span><span class="ai-mode">' + esc(data.mode || "extractive") + "</span></div>" +
        '<p class="ai-text">' + esc(data.answer || "").replace(/\n/g, "<br>") + "</p>" +
        (srcHTML ? '<ol class="ai-sources">' + srcHTML + "</ol>" : "") +
        "</div>";
    } catch (e) {
      $("ai-full").innerHTML = '<p class="empty">AI unavailable.</p>';
    }
  }

  /* ---------------- URL state ---------------- */
  function pushUrl() {
    var url = new URL(location.href);
    url.searchParams.set("q", state.q);
    url.searchParams.set("tab", state.tab);
    if (state.page > 1) url.searchParams.set("page", String(state.page));
    else url.searchParams.delete("page");
    history.replaceState(null, "", url.toString());
  }

  /* ---------------- Settings modal ---------------- */
  function openModal(id) { $(id).hidden = false; document.body.style.overflow = "hidden"; }
  function closeModal(el) { el.hidden = true; document.body.style.overflow = ""; }

  function refreshSettingsUI() {
    $("setting-ai").checked = !!settings.ai;
    $("setting-safety").checked = !!settings.safety;
    $("setting-proxylinks").checked = !!settings.proxyLinks;
    $("setting-perpage").value = String(settings.perPage);
  }

  function bindSettings() {
    $("setting-ai").addEventListener("change", function (e) { settings.ai = e.target.checked; saveSettings(settings); });
    $("setting-safety").addEventListener("change", function (e) { settings.safety = e.target.checked; saveSettings(settings); });
    $("setting-proxylinks").addEventListener("change", function (e) { settings.proxyLinks = e.target.checked; saveSettings(settings); });
    $("setting-perpage").addEventListener("change", function (e) {
      settings.perPage = Math.max(10, Math.min(100, Number(e.target.value) || 50));
      saveSettings(settings);
    });
    $("submit-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var url = $("submit-url").value.trim();
      if (!url) return;
      try {
        var res = await fetch("/api/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url }),
        });
        var data = await res.json();
        $("submit-url").value = "";
        alert(data.ok ? "Thanks — we'll crawl and index this." : (data.error || "Could not queue."));
      } catch (err) {
        alert("Could not queue.");
      }
    });
  }

  /* ---------------- Auth modal ---------------- */
  async function refreshAuth() {
    try {
      var r = await fetch("/api/auth/me", { credentials: "same-origin" });
      var j = await r.json();
      me = j.user || null;
      authConfig = j.config || { google: false, email: false };
    } catch (e) { me = null; }
    applyAuthUI();
  }

  function applyAuthUI() {
    $("google-signin-wrap").hidden = !authConfig.google;
    $("magic-form").hidden = !authConfig.email;
    var signedOut = !me;
    $("auth-signed-out").hidden = !signedOut;
    $("auth-signed-in").hidden = signedOut;
    if (me) {
      $("auth-who").textContent = me.email || me.name || "you";
    }
    if (!authConfig.google && !authConfig.email && !me) {
      $("auth-signed-out").innerHTML =
        '<p class="hint" style="margin-top:0">' +
        'Sign-in is not configured on this server yet. Atomic still works fully ' +
        'anonymously — all features except the download scanner are available to everyone.' +
        "</p>";
    }
  }

  function bindAuth() {
    $("magic-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var email = $("magic-email").value.trim();
      if (!email) return;
      $("magic-hint").textContent = "Sending link…";
      try {
        var res = await fetch("/api/auth/magic/request", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: email }),
        });
        var data = await res.json();
        if (data.ok) {
          $("magic-hint").textContent = data.message || "Check your inbox for a sign-in link.";
        } else {
          $("magic-hint").textContent = data.error || "Could not send sign-in link.";
        }
      } catch (err) {
        $("magic-hint").textContent = "Could not send sign-in link.";
      }
    });

    $("google-signin").addEventListener("click", function () {
      window.location.href = "/api/auth/google/start";
    });

    $("sign-out").addEventListener("click", async function () {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" }).catch(function () {});
      me = null;
      applyAuthUI();
    });

    $("scan-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var url = $("scan-url").value.trim();
      if (!url) return;
      var out = $("scan-result");
      out.style.display = "block";
      out.textContent = "Scanning…";
      try {
        var res = await fetch("/api/scan/file", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url }),
          credentials: "same-origin",
        });
        var data = await res.json();
        out.textContent = JSON.stringify(data, null, 2);
      } catch (err) {
        out.textContent = "Scan failed.";
      }
    });
  }

  /* ---------------- Boot ---------------- */
  document.addEventListener("DOMContentLoaded", function () {
    // Modal open/close wiring.
    var openSettings = function () { refreshSettingsUI(); openModal("settings-modal"); };
    var openAuth = function () { refreshAuth().then(function () { openModal("auth-modal"); }); };
    $("open-settings").addEventListener("click", openSettings);
    $("open-settings-home").addEventListener("click", openSettings);
    $("open-submit-home").addEventListener("click", function () {
      refreshSettingsUI();
      openModal("settings-modal");
      setTimeout(function () { $("submit-url").focus(); }, 80);
    });
    $("open-auth").addEventListener("click", openAuth);
    $("open-auth-home").addEventListener("click", openAuth);
    Array.prototype.forEach.call(document.querySelectorAll(".modal-close"), function (b) {
      b.addEventListener("click", function (e) {
        var m = e.target.closest(".modal-backdrop");
        if (m) closeModal(m);
      });
    });
    Array.prototype.forEach.call(document.querySelectorAll(".modal-backdrop"), function (bd) {
      bd.addEventListener("click", function (e) { if (e.target === bd) closeModal(bd); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      var open = document.querySelector(".modal-backdrop:not([hidden])");
      if (open) closeModal(open);
    });

    bindSettings();
    bindAuth();
    refreshAuth();

    // Tab wiring.
    Array.prototype.forEach.call(document.querySelectorAll(".tabs button"), function (b) {
      b.addEventListener("click", function () { setTab(b.getAttribute("data-tab")); });
    });

    // Forms.
    function submitQuery(q) {
      q = (q || "").trim();
      if (!q) return;
      state.q = q;
      state.page = 1;
      showResults();
      $("q").value = q;
      pushUrl();
      setTab(state.tab);
    }
    $("home-form").addEventListener("submit", function (e) {
      e.preventDefault();
      submitQuery($("q-hero").value);
    });
    $("form").addEventListener("submit", function (e) {
      e.preventDefault();
      submitQuery($("q").value);
    });

    // Stats on home.
    fetch("/api/stats").then(function (r) { return r.json(); }).then(function (s) {
      if (!s) return;
      $("stats").textContent =
        (s.persistent
          ? "Atomic index: " + (s.pages || 0) + " pages indexed · " + (s.queue || 0) + " in queue"
          : "Atomic is running. Submit sites to grow the index.") +
        " · " + (s.cacheEntries || 0) + " cached queries";
    }).catch(function () {});

    // Boot: honour ?q=… on first load.
    try {
      var url = new URL(location.href);
      var q = url.searchParams.get("q");
      var tab = url.searchParams.get("tab");
      var pageParam = parseInt(url.searchParams.get("page") || "1", 10);
      if (pageParam && pageParam > 0) state.page = pageParam;
      if (q) {
        state.q = q;
        state.tab = tab || "all";
        $("q").value = q;
        showResults();
        setTab(state.tab);
      } else {
        showHome();
      }
    } catch (e) { showHome(); }

    // Keyboard: focus search with "/"
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && !/input|textarea|select/i.test(e.target.tagName || "")) {
        e.preventDefault();
        var el = $("q") || $("q-hero");
        if (el) el.focus();
      }
    });
  });
})();

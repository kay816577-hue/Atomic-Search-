(function () {
  "use strict";

  var state = { tab: "all", query: "", lastResults: [] };

  var $ = function (id) { return document.getElementById(id); };
  var home = $("home");
  var aiSummary = $("ai-summary");
  var results = $("results");
  var imagesGrid = $("images-grid");
  var aiFull = $("ai-full");
  var empty = $("empty");
  var stats = $("stats");
  var tabsEl = $("tabs");

  function proxied(url) {
    return "/proxy?url=" + encodeURIComponent(url);
  }

  function hostFromUrl(url) {
    try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
  }

  function setTab(tab) {
    state.tab = tab;
    [].forEach.call(tabsEl.querySelectorAll("button"), function (b) {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    results.hidden = tab !== "all" && tab !== "news";
    imagesGrid.hidden = tab !== "images";
    aiFull.hidden = tab !== "ai";
    if (state.query) renderTab();
  }

  function renderResult(r, idx) {
    var el = document.createElement("article");
    el.className = "result";
    var engines = (r.engines || [])
      .map(function (e) { return '<span>' + e + '</span>'; })
      .join("");
    var host = r.host || hostFromUrl(r.url);
    el.innerHTML =
      '<div class="host-line">' +
      '<span class="fav"></span>' +
      '<span class="host">' + host + '</span>' +
      '<span class="engines">' + engines + '</span>' +
      '</div>' +
      '<a class="title" target="_blank" rel="noreferrer noopener nofollow" href="' + proxied(r.url) + '">' +
        escapeHtml(r.title || r.url) +
      '</a>' +
      '<p class="snippet">' + escapeHtml(r.snippet || "") + '</p>';
    return el;
  }

  function escapeHtml(s) {
    return String(s || "")
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function renderResults(list) {
    results.innerHTML = "";
    if (!list.length) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    var frag = document.createDocumentFragment();
    list.forEach(function (r, i) { frag.appendChild(renderResult(r, i)); });
    results.appendChild(frag);
  }

  function renderImages(list) {
    imagesGrid.innerHTML = "";
    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      var a = document.createElement("a");
      a.href = r.source ? proxied(r.source) : proxied(r.image);
      a.target = "_blank"; a.rel = "noreferrer noopener nofollow";
      var img = document.createElement("img");
      img.src = proxied(r.thumbnail || r.image);
      img.loading = "lazy";
      img.alt = r.title || "";
      var cap = document.createElement("div");
      cap.className = "caption";
      cap.textContent = r.title || "";
      a.appendChild(img); a.appendChild(cap);
      frag.appendChild(a);
    });
    imagesGrid.appendChild(frag);
  }

  function renderAISummary(ans) {
    if (!ans || !ans.answer) { aiSummary.hidden = true; return; }
    aiSummary.hidden = false;
    $("ai-mode").textContent = ans.mode === "llm" ? "open-source LLM" : "extractive";
    $("ai-text").textContent = ans.answer;
    var ol = $("ai-sources");
    ol.innerHTML = "";
    (ans.sources || []).forEach(function (s) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = proxied(s.url); a.target = "_blank";
      a.rel = "noreferrer noopener nofollow";
      a.textContent = s.host + " — " + s.title;
      li.appendChild(a);
      ol.appendChild(li);
    });
  }

  function renderAIFull(ans) {
    aiFull.innerHTML = "";
    var box = document.createElement("div");
    box.className = "ai-summary";
    var mode = ans.mode === "llm" ? "open-source LLM" : "extractive summary";
    box.innerHTML =
      '<div class="ai-head"><span class="ai-badge">AI answer</span><span class="ai-mode">' + mode + '</span></div>' +
      '<div class="ai-text"></div>' +
      '<ol class="ai-sources"></ol>';
    box.querySelector(".ai-text").textContent = ans.answer;
    var ol = box.querySelector(".ai-sources");
    (ans.sources || []).forEach(function (s) {
      var li = document.createElement("li");
      var a = document.createElement("a");
      a.href = proxied(s.url); a.target = "_blank";
      a.rel = "noreferrer noopener nofollow";
      a.textContent = s.host + " — " + s.title;
      li.appendChild(a);
      ol.appendChild(li);
    });
    aiFull.appendChild(box);
  }

  function loadingInto(el, label) {
    el.innerHTML = '<div class="empty"><span class="loading"></span> ' + label + '</div>';
    el.hidden = false;
  }

  async function doSearch(q) {
    state.query = q;
    home.hidden = true;
    aiSummary.hidden = true;
    empty.hidden = true;
    document.title = q + " — Atomic Search";
    try { history.replaceState(null, "", "/?q=" + encodeURIComponent(q) + "&tab=" + state.tab); } catch (e) {}

    if (state.tab === "all" || state.tab === "news") {
      loadingInto(results, "Searching the web privately…");
      imagesGrid.hidden = true; aiFull.hidden = true;
      try {
        var res = await fetch("/api/search?q=" + encodeURIComponent(q));
        var data = await res.json();
        state.lastResults = data.results || [];
        var list = state.lastResults;
        if (state.tab === "news") {
          list = list.filter(function (r) {
            return /news|times|bbc|cnn|reuters|guardian|post|journal/i.test(r.host || "");
          });
          if (!list.length) list = state.lastResults;
        }
        renderResults(list);
        // Parallel: AI summary.
        fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q })
        })
          .then(function (r) { return r.json(); })
          .then(renderAISummary)
          .catch(function () {});
      } catch (e) {
        results.innerHTML = '<div class="empty">Something went wrong. Try again.</div>';
      }
    } else if (state.tab === "images") {
      results.hidden = true;
      loadingInto(imagesGrid, "Loading images…");
      try {
        var res2 = await fetch("/api/images?q=" + encodeURIComponent(q));
        var data2 = await res2.json();
        if (!(data2.results || []).length) {
          imagesGrid.innerHTML = '<div class="empty">No images found.</div>';
        } else {
          renderImages(data2.results);
        }
      } catch (e) {
        imagesGrid.innerHTML = '<div class="empty">Image search failed.</div>';
      }
    } else if (state.tab === "ai") {
      results.hidden = true; imagesGrid.hidden = true;
      loadingInto(aiFull, "Thinking…");
      try {
        var res3 = await fetch("/api/ai", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q })
        });
        var data3 = await res3.json();
        renderAIFull(data3);
      } catch (e) {
        aiFull.innerHTML = '<div class="empty">AI mode failed.</div>';
      }
    }
  }

  function renderTab() { if (state.query) doSearch(state.query); }

  // ---- wire up ----
  function onSubmit(input) {
    return function (ev) {
      ev.preventDefault();
      var q = input.value.trim();
      if (!q) return;
      $("q").value = q;
      doSearch(q);
    };
  }
  $("search-form").addEventListener("submit", onSubmit($("q")));
  $("search-form-hero").addEventListener("submit", onSubmit($("q-hero")));

  tabsEl.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-tab]");
    if (!b) return;
    setTab(b.dataset.tab);
  });

  $("submit-btn").addEventListener("click", async function () {
    var url = $("submit-url").value.trim();
    if (!/^https?:\/\//i.test(url)) { alert("Enter a valid https:// URL"); return; }
    var res = await fetch("/api/submit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url })
    });
    var data = await res.json().catch(function () { return {}; });
    $("submit-url").value = "";
    alert(data.ok ? "Thanks — queued for indexing." : "Could not queue.");
  });

  // Stats on home.
  fetch("/api/stats")
    .then(function (r) { return r.json(); })
    .then(function (s) {
      stats.textContent =
        (s.persistent
          ? "Our growing index: " + s.pages + " pages · " + s.queue + " in queue"
          : "Running in serverless mode — cached results only.") +
        " · " + s.cacheEntries + " cached queries";
    })
    .catch(function () {});

  // Boot: honour ?q=… on first load.
  try {
    var url = new URL(location.href);
    var q = url.searchParams.get("q");
    var tab = url.searchParams.get("tab");
    if (tab) setTab(tab);
    if (q) { $("q").value = q; doSearch(q); }
  } catch (e) {}

  // Keyboard: focus search with "/"
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && !/input|textarea|select/i.test((e.target.tagName || ""))) {
      e.preventDefault();
      ($("q") || $("q-hero")).focus();
    }
  });
})();

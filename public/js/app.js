(function () {
  "use strict";

  var state = { tab: "all", query: "", page: 1, lastResults: [], hasMore: false, loadingMore: false };

  var $ = function (id) { return document.getElementById(id); };
  var home = $("home");
  var aiSummary = $("ai-summary");
  var results = $("results");
  var imagesGrid = $("images-grid");
  var aiFull = $("ai-full");
  var empty = $("empty");
  var stats = $("stats");
  var tabsEl = $("tabs");
  var pager = $("pager");

  // Outbound clicks go to /go (safety-check interstitial) which then
  // forwards through /proxy. Image sources still use /proxy directly so they
  // render inline without an extra hop.
  function safeLink(url) {
    return "/go?url=" + encodeURIComponent(url);
  }
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
    if (pager) pager.hidden = !(tab === "all" || tab === "news");
    if (state.query) renderTab();
  }

  function renderResult(r) {
    var el = document.createElement("article");
    el.className = "result";
    var host = r.host || hostFromUrl(r.url);
    el.innerHTML =
      '<div class="host-line">' +
      '<span class="fav"></span>' +
      '<span class="host">' + escapeHtml(host) + '</span>' +
      '</div>' +
      '<a class="title" target="_blank" rel="noreferrer noopener nofollow" href="' + safeLink(r.url) + '">' +
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

  function renderResults(list, append) {
    if (!append) results.innerHTML = "";
    if (!list.length && !append) {
      empty.hidden = false;
      return;
    }
    empty.hidden = true;
    var frag = document.createDocumentFragment();
    list.forEach(function (r) { frag.appendChild(renderResult(r)); });
    results.appendChild(frag);
  }

  function renderImages(list) {
    imagesGrid.innerHTML = "";
    var frag = document.createDocumentFragment();
    list.forEach(function (r) {
      var a = document.createElement("a");
      a.href = safeLink(r.source || r.image);
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
      a.href = safeLink(s.url); a.target = "_blank";
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
      a.href = safeLink(s.url); a.target = "_blank";
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

  function updatePager() {
    if (!pager) return;
    pager.innerHTML = "";
    if (!(state.tab === "all" || state.tab === "news")) { pager.hidden = true; return; }
    pager.hidden = false;
    var info = document.createElement("span");
    info.className = "pager-info";
    info.textContent = "Page " + state.page + " · " + state.lastResults.length + " results";
    var prev = document.createElement("button");
    prev.type = "button";
    prev.textContent = "‹ Prev";
    prev.disabled = state.page <= 1 || state.loadingMore;
    prev.addEventListener("click", function () { goToPage(state.page - 1); });
    var next = document.createElement("button");
    next.type = "button";
    next.textContent = state.loadingMore ? "Loading…" : "Next ›";
    next.disabled = !state.hasMore || state.loadingMore;
    next.addEventListener("click", function () { goToPage(state.page + 1); });
    pager.appendChild(prev);
    pager.appendChild(info);
    pager.appendChild(next);
  }

  function goToPage(n) {
    if (n < 1) return;
    state.page = n;
    doSearch(state.query);
    try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch (e) {}
  }

  async function doSearch(q) {
    state.query = q;
    home.hidden = true;
    aiSummary.hidden = true;
    empty.hidden = true;
    document.title = q + " — Atomic Search";
    try {
      history.replaceState(
        null,
        "",
        "/?q=" + encodeURIComponent(q) + "&tab=" + state.tab + "&page=" + state.page
      );
    } catch (e) {}

    if (state.tab === "all" || state.tab === "news") {
      loadingInto(results, "Searching the web privately…");
      imagesGrid.hidden = true; aiFull.hidden = true;
      state.loadingMore = true; updatePager();
      try {
        var res = await fetch(
          "/api/search?q=" + encodeURIComponent(q) +
          "&page=" + state.page + "&per_page=100"
        );
        var data = await res.json();
        state.lastResults = data.results || [];
        state.hasMore = !!data.hasMore;
        var list = state.lastResults;
        if (state.tab === "news") {
          list = list.filter(function (r) {
            return /news|times|bbc|cnn|reuters|guardian|post|journal|ap\.org|npr|axios|theverge|techcrunch|wired/i.test(r.host || "");
          });
          if (!list.length) list = state.lastResults;
        }
        renderResults(list, false);
        state.loadingMore = false; updatePager();
        // Parallel: AI summary only on page 1.
        if (state.page === 1) {
          fetch("/api/ai", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ q })
          })
            .then(function (r) { return r.json(); })
            .then(renderAISummary)
            .catch(function () {});
        }
      } catch (e) {
        results.innerHTML = '<div class="empty">Something went wrong. Try again.</div>';
        state.loadingMore = false; updatePager();
      }
    } else if (state.tab === "images") {
      results.hidden = true;
      if (pager) pager.hidden = true;
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
      if (pager) pager.hidden = true;
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
      state.page = 1;
      doSearch(q);
    };
  }
  $("search-form").addEventListener("submit", onSubmit($("q")));
  $("search-form-hero").addEventListener("submit", onSubmit($("q-hero")));

  tabsEl.addEventListener("click", function (ev) {
    var b = ev.target.closest("button[data-tab]");
    if (!b) return;
    state.page = 1;
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
    var pageParam = parseInt(url.searchParams.get("page") || "1", 10);
    if (pageParam && pageParam > 0) state.page = pageParam;
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

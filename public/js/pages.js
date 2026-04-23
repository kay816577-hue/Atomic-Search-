/*
 * Atomic "pages" — static About / Self-hosting / Terms / Privacy / API
 * screens rendered into a modal so the site ships legally-required text
 * and operator-useful reference material without needing a router.
 *
 * Content is intentionally hard-coded HTML (no Markdown parser, no
 * network fetch) so it's CSP-safe and instant to open.
 */
(function () {
  "use strict";

  var origin = location.origin || "https://atomic.example";

  var PAGES = {
    about: {
      title: "About Atomic Search",
      body:
        '<p><strong>Atomic is in beta.</strong> Core features are stable and in daily use, but new functionality lands often — expect the occasional rough edge. Bug reports and PRs are very welcome on <a href="https://github.com/kay816577-hue/Atomic-Search-/issues" target="_blank" rel="noopener">GitHub</a>.</p>' +
        '<p>Atomic is a privacy-first meta-search engine with its own growing anonymous index. ' +
        'One search box, clean UI, zero tracking — and no accounts, no cookies, no per-user data.</p>' +
        '<h3>What makes it different</h3>' +
        '<ul>' +
        '<li><strong>Seven engines, one request.</strong> Startpage, Brave, Bing, DuckDuckGo, Wikipedia, Hacker News, and Reddit are all queried in parallel and their results rank-fused.</li>' +
        '<li><strong>Our own growing index.</strong> Every search grows a private SQLite index of the pages people actually visit. Strong matches from that index are promoted with a visible "FROM OUR OWN INDEX" badge.</li>' +
        '<li><strong>Restart-safe.</strong> On Render / Vercel, the SQLite index is snapshotted to a GitHub data branch every 2 min and restored on boot — so the site, the running server, and GitHub stay in sync forever.</li>' +
        '<li><strong>Zero-config public API.</strong> Anyone can hit <code>/api/v1/search</code> from anywhere, no key required.</li>' +
        '</ul>' +
        '<h3>Open source</h3>' +
        '<p>MIT-licensed. <a href="https://github.com/kay816577-hue/Atomic-Search-" target="_blank" rel="noopener">Source on GitHub</a>.</p>' +
        '<h3>Who builds it</h3>' +
        '<p>Atomic Search is a <strong>UCX Industry</strong> project, founded in 2023 by <strong>Kayan Erkama</strong>. Contributions welcome via pull request.</p>',
    },

    "self-hosting": {
      title: "Self-hosting",
      body:
        '<p>Atomic is designed to be self-hosted. Pick a deployment target:</p>' +
        '<h3>Docker / VPS (recommended)</h3>' +
        '<pre>git clone https://github.com/kay816577-hue/Atomic-Search-.git\n' +
        'cd Atomic-Search-\n' +
        'docker build -t atomic-search .\n' +
        'docker run -d -p 3000:3000 \\\n' +
        '  -v $PWD/data:/data -e DATA_DIR=/data \\\n' +
        '  atomic-search</pre>' +
        '<p>SQLite index lives in the mounted <code>./data</code> volume, so restarts are a non-issue.</p>' +
        '<h3>Render (free tier)</h3>' +
        '<ol>' +
        '<li>Fork the repo on GitHub.</li>' +
        '<li>Create a new Web Service on Render pointing at your fork. <code>render.yaml</code> handles everything.</li>' +
        '<li>Set these env vars so the index survives free-tier filesystem wipes:' +
        '<ul>' +
        '<li><code>GH_INDEX_PAT</code> — fine-grained PAT with <em>Contents: Read and Write</em> on your fork.</li>' +
        '<li><code>GH_INDEX_REPO</code> — <code>your-user/your-fork</code>.</li>' +
        '<li><code>GH_INDEX_BRANCH</code> — default <code>atomic-search-index</code>.</li>' +
        '<li><code>GH_INDEX_INTERVAL</code> — snapshot interval in seconds, default 120.</li>' +
        '</ul></li>' +
        '<li>Deploy. The server will restore from GitHub on every boot <em>before</em> the HTTP listener starts, so the index is always consistent.</li>' +
        '</ol>' +
        '<h3>Vercel</h3>' +
        '<p>Same <code>GH_INDEX_*</code> env vars as Render. The serverless function re-hydrates the SQLite file on cold start.</p>' +
        '<h3>Cloudflare Pages</h3>' +
        '<p>Workers don\'t support better-sqlite3 yet, so the Atomic index runs in LRU-cache fallback mode. Meta-search + anonymous proxy work fine; for a persistent own-index on Cloudflare, use the Render or Docker flavour.</p>' +
        '<h3>Full env reference</h3>' +
        '<p>See the <a href="https://github.com/kay816577-hue/Atomic-Search-#self-hosting" target="_blank" rel="noopener">README</a> for the full list (VirusTotal — optional).</p>',
    },

    api: {
      title: "Public API",
      body:
        '<p>Free, zero-config JSON API — no key, no signup, works straight off the Render server. Per-IP rate limit: <strong>60 requests / minute</strong>.</p>' +
        '<h3>Endpoints</h3>' +
        '<ul>' +
        '<li><code>GET /api/v1/search?q=…&amp;page=1</code> — meta-search across seven engines, rank-fused.</li>' +
        '<li><code>GET /api/v1/images?q=…&amp;page=1</code> — image results.</li>' +
        '<li><code>GET /api/v1/stats</code> — index size + engine health.</li>' +
        '</ul>' +
        '<h3>Example — cURL</h3>' +
        '<pre>curl "' + origin + '/api/v1/search?q=raft+consensus"</pre>' +
        '<h3>Example — JavaScript</h3>' +
        '<pre>const r = await fetch("' + origin + '/api/v1/search?q=" + encodeURIComponent(q));\nconst { results } = await r.json();\nresults.forEach(x =&gt; console.log(x.title, x.url));</pre>' +
        '<h3>Response shape</h3>' +
        '<pre>{\n  "query": "raft consensus",\n  "page": 1,\n  "total": 42,\n  "hasMore": true,\n  "results": [\n    {\n      "title": "Raft (algorithm) - Wikipedia",\n      "url": "https://en.wikipedia.org/wiki/Raft_(algorithm)",\n      "host": "en.wikipedia.org",\n      "snippet": "Raft is a consensus algorithm…",\n      "ownIndex": true,\n      "score": 0.91\n    }\n  ]\n}</pre>' +
        '<p class="hint">All v1 endpoints return CORS-open JSON (<code>Access-Control-Allow-Origin: *</code>). No auth. No logging. No cookies.</p>',
    },

    terms: {
      title: "Terms of Service",
      body:
        '<p><em>These terms describe what the software does and the promises it actually keeps.</em></p>' +
        '<h3>1. Provided as-is</h3>' +
        '<p>Atomic is a meta-search engine. Result quality depends on public upstream engines we do not control. If an upstream blocks us, its engine will back off for 5 minutes while the rest keep serving.</p>' +
        '<h3>2. You own what you search for</h3>' +
        '<p>Titles and short extracts of pages in the index are cached for re-ranking only. Respect the copyright of any page you visit via Atomic.</p>' +
        '<h3>3. No illegal use</h3>' +
        '<p>Don\'t use Atomic to search for, distribute, or scan material that is illegal in your jurisdiction. Attempting to use the safety scanner to verify that malware runs is prohibited.</p>' +
        '<h3>4. No scraping Atomic itself</h3>' +
        '<p>The public API is rate-limited to 60 req/min per IP. Persistent abuse may result in your request being dropped (we don\'t store IPs; we hash them in memory).</p>' +
        '<h3>5. Self-hosted deployments</h3>' +
        '<p>Operators of a fork are responsible for their own local law compliance.</p>' +
        '<h3>6. License</h3>' +
        '<p>Source is MIT. See <code>LICENSE</code> in the repo.</p>',
    },

    privacy: {
      title: "Privacy Notice",
      body:
        '<p><em>This notice is what the code actually does. If you find a discrepancy, it\'s a bug — open an issue.</em></p>' +
        '<h3>What Atomic does NOT store</h3>' +
        '<ul>' +
        '<li><strong>Search queries.</strong> No query log, no SQL table of searches, no file with queries in it.</li>' +
        '<li><strong>IP addresses.</strong> We do not persist your IP. The rate-limiter keeps an in-memory token bucket keyed on a 32-bit FNV hash of your IP and evicts it on idle.</li>' +
        '<li><strong>User-Agent or Referer</strong> from incoming requests.</li>' +
        '<li><strong>Cookies.</strong> Atomic sets <strong>zero cookies</strong>, ever. There is no sign-in, no session, no tracking cookie of any kind.</li>' +
        '<li><strong>Third-party trackers.</strong> The frontend loads only same-origin assets. CSP blocks everything else.</li>' +
        '</ul>' +
        '<h3>What Atomic DOES store</h3>' +
        '<ul>' +
        '<li>The crawl index — page URLs, titles, plain-text extracts, a timestamp. No per-user data attached.</li>' +
        '<li>Submitted URLs (no submitter identity).</li>' +
        '<li>Hash-keyed safety-scan verdicts (cached up to 24 h per URL / file hash).</li>' +
        '</ul>' +
        '<h3>Outbound behaviour</h3>' +
        '<p>Atomic fetches upstream engines from the server, with a generic Firefox UA, no cookies, no Referer, and a hard timeout. Upstream engines see Atomic\'s IP, not yours. Clicks can optionally pass through <code>/go</code> (safety interstitial) or <code>/proxy</code> (anonymous HTML proxy) — both strip IP, Referer, and cookies before the outbound fetch.</p>' +
        '<h3>SSRF guard</h3>' +
        '<p>The <code>/proxy</code> and scan endpoints refuse <code>localhost</code>, RFC1918 ranges, <code>169.254.0.0/16</code> (including the cloud metadata IP), IPv6 loopback/ULA/link-local, and any non-HTTP(S) scheme. See <code>src/safeurl.js</code>.</p>' +
        '<h3>What goes to GitHub</h3>' +
        '<p>The SQLite index is periodically snapshotted to the <code>atomic-search-index</code> branch of the configured repo. The snapshot contains indexed pages only — no query log, no IP, no user data.</p>',
    },
  };

  function openPage(key) {
    var p = PAGES[key];
    if (!p) return;
    var modal = document.getElementById("page-modal");
    var title = document.getElementById("page-title");
    var body = document.getElementById("page-body");
    if (!modal || !title || !body) return;
    title.textContent = p.title;
    body.innerHTML = p.body;
    modal.hidden = false;
  }
  function closePage() {
    var modal = document.getElementById("page-modal");
    if (modal) modal.hidden = true;
  }

  document.addEventListener("click", function (e) {
    var t = e.target;
    // Footer / inline page links: <a data-page="terms">Terms</a>.
    var a = t && t.closest ? t.closest("[data-page]") : null;
    if (a) {
      e.preventDefault();
      openPage(a.getAttribute("data-page"));
      return;
    }
    // Close button or backdrop click.
    if (t.id === "page-close" || t.closest && t.closest("#page-close")) {
      closePage();
      return;
    }
    var modal = document.getElementById("page-modal");
    if (t === modal) closePage();
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closePage();
  });
})();

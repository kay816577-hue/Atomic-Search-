# Atomic Search

A privacy-first search engine with its own growing anonymous index. One
search box, clean Google-style UI, zero tracking.

- **No trackers.** No cookies on anonymous browsing, no referrer, no analytics,
  no logs of queries.
- **Our own index.** A background crawler builds a SQLite index of the pages
  Atomic surfaces; strong matches from the index are promoted above everything
  else and clearly labelled "From our own index". The index grows with every
  search and with every URL you submit.
- **Persistent across restarts.** On Render's free tier (no persistent disk),
  Atomic snapshots its SQLite DB to a data branch of a GitHub repo and
  restores it on boot — no Postgres, no external storage service needed,
  and the site, the running server, and GitHub all stay in sync.
- **Seven-engine meta layer.** Every query fans out anonymously and in
  parallel to Startpage, Brave, Bing, DuckDuckGo, Wikipedia, Hacker News,
  and Reddit. Upstream engines are not identified in the response — results
  are merged under the single "atomic" brand.
- **Smart ranking.** Reciprocal Rank Fusion + cross-source agreement boost
  + keyword relevance + popular-site prior (Wikipedia, MDN, GitHub, arxiv,
  etc. are nudged up when they actually match the query).
- **Anonymous view.** Every outbound click can optionally be rewritten to
  pass through Atomic so the destination never sees your IP or referrer.
- **Safety checks.** A coloured dot on each result shows whether VirusTotal
  has flagged it. A `/go` interstitial runs the full check before you leave.
- **Download scanner.** Signed-in users can paste any download URL and get a
  VirusTotal verdict across 70+ antivirus engines.
- **35+ themes** — dark, light, OLED, futuristic, mood. Tokyo Night,
  Catppuccin, Rosé Pine, Plasma, Synthwave, Matrix, and more.

## Run it locally

```bash
npm install
npm start
# open http://localhost:3000
```

Node ≥ 18 required.

## Self-hosting

Atomic is designed to be self-hosted. Pick a deployment target and follow
the matching section.

### Docker / VPS (recommended for privacy)

```bash
git clone https://github.com/kay816577-hue/Atomic-Search-.git
cd Atomic-Search-
docker build -t atomic-search .
docker run -d --name atomic -p 3000:3000 \
  -v $PWD/data:/data \
  -e DATA_DIR=/data \
  atomic-search
```

Point a reverse proxy (Caddy / nginx / Traefik) at port `3000`. The SQLite
index is stored in the mounted `./data` volume so it survives container
restarts automatically — you don't need the GitHub snapshot mode.

### Render (free tier)

1. Fork this repo to your own GitHub account.
2. Create a new **Web Service** on Render pointing at your fork.
3. `render.yaml` in the repo wires everything up automatically (Node 20,
   `npm install`, `node server.js`).
4. To survive Render's free-tier filesystem wipes, set these env vars on
   the Render service:

   | Variable | Value |
   | --- | --- |
   | `GH_INDEX_PAT` | A GitHub PAT with `contents:write` on your fork |
   | `GH_INDEX_REPO` | `your-user/your-fork` (defaults to the render default) |
   | `GH_INDEX_BRANCH` | `atomic-search-index` (default) |
   | `GH_INDEX_INTERVAL` | `600` (seconds between snapshots, default) |

   With those set, every 10 min the running server commits its SQLite DB
   to the chosen branch. On the next deploy/restart, Atomic restores from
   that branch BEFORE the HTTP server or crawler starts, so the index
   stays in sync across GitHub, the site, and the server forever.

### Vercel

1. Fork this repo.
2. Import it into Vercel. The `api/[[...slug]].js` function handles all
   dynamic routes and `public/` is served statically.
3. Because Vercel serverless functions have no local disk, set the same
   `GH_INDEX_*` env vars as Render above so the index lives on the data
   branch. The function reads it on cold start.

### Cloudflare Pages

1. Fork this repo.
2. Create a new Cloudflare Pages project pointed at it. `wrangler.toml` +
   `functions/[[path]].js` handle the routing.
3. Cloudflare Workers don't currently support better-sqlite3; the Atomic
   index runs in the LRU-cache fallback mode only. Meta-search and the
   anonymous proxy work fine. If you want a persistent own-index on
   Cloudflare, deploy the Render/VPS flavour instead.

### Generate a GitHub PAT

The restart-safe index persistence needs a fine-grained PAT:

1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → **Generate new token**.
2. Repository access: only the fork you're deploying (e.g. `your-user/Atomic-Search-`).
3. Repository permissions → **Contents: Read and write**.
4. Copy the token and paste it into `GH_INDEX_PAT` on Render / Vercel.

The token is only used to push the SQLite file. It is never exposed to
clients, never logged, and never used for anything else.

### Full environment variable reference (all optional)

| Variable | Purpose |
| --- | --- |
| `VIRUSTOTAL_API_KEY` | Enables URL + download safety checks |
| `GH_INDEX_PAT` | GitHub PAT (`contents:write`) for index persistence |
| `GH_INDEX_REPO` | Override the repo used for snapshots |
| `GH_INDEX_BRANCH` | Branch name for snapshots (default `atomic-search-index`) |
| `GH_INDEX_INTERVAL` | Snapshot interval in seconds (default 600) |
| `ENABLE_MARGINALIA` | Set to `1` to also query the Marginalia small-web engine |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | "Continue with Google" sign-in. Redirect URI: `https://<host>/api/auth/google/callback` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Email magic-link sign-in |
| `ATOMIC_SESSION_SECRET` | Long random string for signing session cookies |
| `HF_API_TOKEN` / `OPENAI_API_KEY` / `OPENAI_API_BASE` / `OPENAI_MODEL` | Optional AI backends |
| `DATA_DIR` | Where to put the SQLite DB (default `./data`) |
| `PORT` | Server port (default 3000) |

Without any of these, Atomic still runs end-to-end — just without safety
badges, sign-in, or cross-restart persistence.

## How the index works

1. You search. Atomic fans out across seven engines in parallel — all with
   spoofed UA, no cookies, no referrer — and combines the results.
2. Results are rank-fused, de-duplicated, keyword-scored, and popular-site-
   weighted. Any strong matches from our own indexed pages are promoted
   to the top and visually badged.
3. The top result URLs are added to the crawl queue. A background worker
   pulls from that queue every 5 seconds, fetches the page, strips it to
   plain text, and writes it to SQLite. Stale pages (>14 days old) are
   re-crawled hourly.
4. Every `GH_INDEX_INTERVAL` seconds (default 600 = 10 min) the SQLite
   file is committed + pushed to the data branch of the configured repo.
   On boot, `startIndexSync()` runs BEFORE the HTTP server or crawler
   start, so the index is always restored to the latest good snapshot
   before anyone can write to it.
5. Submitting a URL via the Submit dialog crawls it eagerly and kicks an
   immediate snapshot, so "add → it's in our index → it's on GitHub"
   holds within the next tick, not the next interval.

The net result: the on-GitHub snapshot, the running server, and the live
site are always in sync — even across Render's free-tier deploy wipes.

## Terms of Service

_Last updated: 2026. These terms apply to atomicsearch.io and any other
deployment of this codebase. They describe what the software does and the
promises it actually keeps._

By using Atomic Search you agree that:

1. **Atomic is provided "as is"**, with no warranty. It is a meta-search
   engine; the result quality depends on public upstream engines we do
   not control. If an upstream engine blocks us, some queries may return
   fewer results until its self-healing tracker resets.
2. **Atomic does not own the content of indexed pages.** Titles and short
   extracts are cached for re-ranking only. You must respect the
   copyright of any page you visit via Atomic.
3. **No illegal use.** Don't use Atomic to search for, distribute, or
   scan material that is illegal in your jurisdiction. Attempting to use
   the safety scanner to confirm that malware runs is prohibited.
4. **No scraping of Atomic itself.** The `/api/search` endpoint is
   rate-limited. Persistent abuse may result in your IP's request being
   throttled (we hash it in memory, we never store it).
5. **Self-hosted deployments are your responsibility.** Operators of a
   fork must comply with their own local law and, if they enable
   sign-in, inform their users about data retention appropriate to
   their deployment.

The source code is released under the MIT license; see `LICENSE`.

## Privacy Notice

_Last updated: 2026. This notice is what the code actually does today.
If you find a discrepancy, it is a bug — open an issue._

### What Atomic DOES NOT store

- **Search queries.** Your query is passed to the upstream engines at
  request time and discarded. There is no query log, no SQL table of
  searches, no file written to disk containing queries.
- **IP addresses.** We do not log or persist the IP address of any
  search request. The rate limiter keeps a short-lived in-memory token
  bucket keyed by a SHA-256 hash of the IP; the bucket is evicted on
  idle and never written to disk.
- **User-Agent or Referer strings** of incoming requests.
- **Analytics cookies.** Atomic sets zero cookies unless you are signed
  in — in which case the only cookie is a session token (HMAC-signed,
  HTTP-only, SameSite=Lax, expires).
- **Third-party trackers.** The frontend loads only assets served from
  the same origin.

### What Atomic DOES store

- **The crawl index** — page URLs, titles, plain-text extracts, and a
  timestamp — for the subset of pages it indexes. This is the "our
  own index" that powers ranking. No per-user information is attached
  to any indexed page.
- **Submitted URLs.** If you click "Submit a URL", the URL is kept so
  the crawler can prioritise it. Your IP is not associated with the
  submission.
- **Safety-scan verdicts.** Hash-keyed verdicts from VirusTotal are
  cached (up to 24 h per URL / file hash) so we don't re-hit the API.

### Outbound behaviour

- Atomic fetches upstream engines from its server, with a generic
  Firefox User-Agent, no cookies, no Referer, and a hard timeout. The
  upstream engines see Atomic's IP, not yours.
- Clicks on results can optionally route through `/go` (a safety
  interstitial) or `/proxy` (an anonymous HTML proxy). Both drop your
  IP, referrer, and cookies before the outbound fetch.

### Sign-in (optional)

If the operator has configured Google OAuth or SMTP magic-link sign-in,
the only user data stored is: the email address you signed in with, a
numeric user id, and the session expiry. You can delete your account at
any time by signing out and contacting the operator.

### SSRF + sandbox guarantees

The `/proxy` and `/api/scan/file` endpoints refuse to fetch:
`localhost`, `127.0.0.0/8`, `169.254.0.0/16` (including the cloud
metadata IP `169.254.169.254`), `10.0.0.0/8`, `172.16.0.0/12`,
`192.168.0.0/16`, IPv6 loopback/ULA/link-local, and any non-HTTP(S)
scheme. See `src/safeurl.js`.

### Data that IS persisted to GitHub

The SQLite index (`atomic.db`) is periodically snapshotted to the
`atomic-search-index` branch of the configured repo. This snapshot
contains indexed pages only — no query log, no IP, no user data. If
you delete the branch, the next boot starts with an empty index.

## License

MIT.

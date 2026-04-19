# Atomic Search

A privacy-first meta-search engine that aggregates results from
**DuckDuckGo · Bing · Brave · Luxxle** (via a public SearXNG instance) into
one ranked list, proxies every outbound click to hide your IP/referrer, and
ships with an optional **AI answer** mode powered by open-source LLMs.

- **No trackers.** No cookies. No referrer. No analytics. No logs of queries.
- **One search, every engine.** Rank-fused results, de-duplicated by URL.
- **Proxied clicks.** Outbound links go through `/proxy?url=…` so the target
  site never sees your IP. HTML is rewritten so embedded links stay proxied.
- **Images tab** — DuckDuckGo + Bing image search merged.
- **AI mode** — extractive summary by default; optional open-source LLMs
  (HuggingFace Inference, Ollama, LM Studio, any OpenAI-compatible endpoint).
- **Growing index** — when running on Node with a writable disk, Atomic Search
  also runs its own background crawler and caches results in SQLite.
- **Integrated Wavesound player** — floating music player that streams
  royalty-free tracks from the Audius open network.
- **Themes** — Atom Dark, Atom Light, Neon, Dracula, Solar.

## Run it locally

```bash
npm install
npm start
# open http://localhost:3000
```

Node ≥ 18 required. `better-sqlite3` is an *optional* dependency — if it fails
to build (rare), Atomic Search falls back to an in-memory cache and everything
still works; only the growing on-disk index is skipped.

## Deploy anywhere

Atomic Search is built with [Hono](https://hono.dev), so the same app runs on
Node, Cloudflare Workers/Pages and Vercel serverless.

### Render
[`render.yaml`](./render.yaml) is ready to go. Click "New +" → "Blueprint" →
point it at this repo. Includes a 1 GB persistent disk so the crawler index
survives restarts.

### Vercel
Just import the repo. [`vercel.json`](./vercel.json) routes `/api/*` and
`/proxy` to [`api/[[...slug]].js`](./api/[[...slug]].js) (the Hono app) and
serves `public/` statically. In serverless mode, the cache is in-memory per
instance (no persistent crawler).

### Cloudflare Pages
Connect the repo in the Cloudflare dashboard. Build command: `npm install`.
Output directory: `public`. Pages Functions from
[`functions/[[path]].js`](./functions/[[path]].js) handle `/api/*` and
`/proxy`. [`wrangler.toml`](./wrangler.toml) sets the `nodejs_compat` flag.

### Docker / anywhere else
```bash
docker build -t atomic-search .
docker run -p 3000:3000 -v atomic-data:/data atomic-search
```

## Environment variables

All optional. Defaults to zero-config.

| Variable            | Purpose                                                                 |
|---------------------|-------------------------------------------------------------------------|
| `PORT`              | HTTP port for the Node server (default `3000`).                         |
| `DATA_DIR`          | Where to store the SQLite DB (default `./data`).                        |
| `SEARXNG_URL`       | SearXNG instance used as the "Luxxle" slot (default `https://searx.be`).|
| `HF_API_TOKEN`      | Enables open-source LLM answers via HuggingFace Inference.              |
| `HF_MODEL`          | HF model id (default `HuggingFaceH4/zephyr-7b-beta`).                   |
| `OPENAI_BASE_URL`   | OpenAI-compatible endpoint (Ollama, LM Studio, groq, together.ai, …).   |
| `OPENAI_API_KEY`    | Optional auth for the above.                                            |
| `OPENAI_MODEL`      | Model name for the OpenAI-compatible endpoint (default `llama3`).       |
| `VIRUSTOTAL_API_KEY`| Enables VirusTotal safety check on every outbound click (free tier, 500 req/day). Grab one at https://www.virustotal.com/gui/my-apikey. |

## Architecture

```
public/                static SPA (themes, tabs, music player)
src/
  app.js               Hono app (routes: /api/*, /proxy)
  aggregator.js        DDG + Bing + Brave + Luxxle meta-search, RRF merge
  images.js            DDG + Bing image search
  ai.js                extractive summary + optional LLM
  proxy.js             anonymising URL proxy (HTML rewriter)
  storage.js           LRU cache (everywhere) + SQLite (Node only)
  crawler.js           Node-only background crawler
  util.js              fetch helpers, sanitisers
server.js              Node entrypoint (Render/Docker/VPS)
api/[[...slug]].js     Vercel entrypoint
functions/[[path]].js  Cloudflare Pages Functions entrypoint
```

## Privacy

- No request logging. We do not write IPs, user-agents, or queries to disk.
- The proxy strips `Cookie`, `Authorization`, `Referer`, `X-Forwarded-For`
  and similar headers **on the way out**, and `Set-Cookie` on the way back.
- Every response carries `Referrer-Policy: no-referrer` and
  `Permissions-Policy: interest-cohort=(), browsing-topics=()`.
- The in-memory LRU caches only the query → results mapping; persistent
  SQLite caches only crawled pages and submitted URLs.

Contributions welcome.

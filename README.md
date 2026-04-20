# Atomic Search

A privacy-first search engine with its own growing anonymous index. One
search box, clean Google-style UI, zero tracking.

- **No trackers.** No cookies, no referrer, no analytics, no logs of queries.
- **Our own index.** A background crawler builds an SQLite index of the pages
  Atomic surfaces; strong matches from the index are promoted above everything
  else. The index grows with every search.
- **Persistent across restarts.** On Render's free tier (no persistent disk)
  Atomic snapshots its index to a data branch of this GitHub repo and restores
  it on boot — no external storage service needed.
- **Anonymous view.** Every outbound click can optionally be rewritten to pass
  through Atomic so the destination never sees your IP.
- **Safety checks.** A coloured dot on each result shows whether VirusTotal
  has flagged it. A `/go` interstitial runs the full check before you leave.
- **Download scanner.** Signed-in users can paste any download URL and get a
  VirusTotal verdict across 70+ antivirus engines.
- **Optional AI answers** — off by default. Extractive summaries over our own
  index with zero config; pluggable HuggingFace / OpenAI-compatible backends.
- **12 themes** and a proper settings page.

## Run it locally

```bash
npm install
npm start
# open http://localhost:3000
```

Node ≥ 18 required.

## Deploy

| Platform         | How                                                                 |
| ---------------- | ------------------------------------------------------------------- |
| Render           | Connect the repo; `render.yaml` handles the rest                    |
| Vercel           | Connect the repo; uses `api/[[...slug]].js` + static `public/`      |
| Cloudflare Pages | Connect the repo; `wrangler.toml` + `functions/[[path]].js`         |
| Docker / VPS     | `docker build . && docker run -p 3000:3000 atomic-search`           |

### Environment variables (all optional)

| Variable | Purpose |
| --- | --- |
| `VIRUSTOTAL_API_KEY` | Enables URL + download safety checks |
| `GH_INDEX_PAT` | GitHub PAT (`contents:write`) that lets Atomic snapshot its SQLite index to a data branch so it survives restarts on Render free tier |
| `GH_INDEX_REPO` | Override the repo used for snapshots (default: this repo) |
| `GH_INDEX_BRANCH` | Branch name for snapshots (default `atomic-search-index`) |
| `GH_INDEX_INTERVAL` | Snapshot interval in seconds (default 600) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Enable "Continue with Google" sign-in. Redirect URI must be `https://<host>/api/auth/google/callback` |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_FROM` | Enable email sign-in ("send me a link") |
| `ATOMIC_SESSION_SECRET` | Long random string for signing session cookies |
| `HF_API_TOKEN` / `OPENAI_API_KEY` / `OPENAI_API_BASE` / `OPENAI_MODEL` | Optional AI backends |
| `DATA_DIR` | Where to put the SQLite db (default `./data`) |
| `PORT` | Server port (default 3000) |

Without any of these, Atomic still runs end-to-end: extractive AI, no safety
badges, no sign-in, ephemeral index.

## How the index works

1. You search. Atomic fans out across multiple public search endpoints.
2. Results are rank-fused, de-duplicated, and any strong matches from our own
   indexed pages are promoted to the top.
3. The top result URLs are added to the crawl queue. A background worker pulls
   from that queue every 5 seconds, fetches the page, strips it to plain text,
   and writes it to SQLite.
4. On Render, every 10 minutes we commit the SQLite db to the data branch of
   this repo. On boot we restore it before the crawler starts writing.

## Privacy

- Query strings are never logged.
- IP addresses, user-agents, and referrers are never stored.
- Outbound HTML fetched through the anonymous view has tracking scripts
  neutered and links rewritten to stay inside the view.
- The cookie used for sign-in is HMAC-signed, HTTP-only, SameSite=Lax, and
  contains only a numeric user id + expiry.

## License

MIT.

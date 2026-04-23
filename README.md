# Atomic Search — persistent crawl index

This branch holds `atomic.db`, the SQLite crawl index for [kay816577-hue/Atomic-Search-](https://github.com/kay816577-hue/Atomic-Search-).

- The running server **restores** this file on every cold start, so Render restarts don't wipe the index.
- The server **pushes** new snapshots here when `GH_INDEX_PAT` is set (optional). Without a PAT the server still restores the latest snapshot (branch is public) — it just won't grow the persisted index.

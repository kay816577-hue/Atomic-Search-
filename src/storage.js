// Storage: in-memory LRU cache that works everywhere (Node, Vercel, Workers),
// optionally backed by SQLite on Node/Render/Docker when `better-sqlite3` is
// available AND a writable DATA_DIR is provided. All storage is for OUR cache
// only — NEVER user-identifying data (IPs, cookies, user-agents).

const now = () => Date.now();

class LRU {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map();
  }
  get(k) {
    if (!this.map.has(k)) return undefined;
    const v = this.map.get(k);
    this.map.delete(k);
    this.map.set(k, v);
    return v;
  }
  set(k, v) {
    if (this.map.has(k)) this.map.delete(k);
    this.map.set(k, v);
    if (this.map.size > this.max) {
      const firstKey = this.map.keys().next().value;
      this.map.delete(firstKey);
    }
  }
  delete(k) {
    this.map.delete(k);
  }
  size() {
    return this.map.size;
  }
}

let sqlite = null;
let db = null;

async function tryLoadSqlite() {
  if (sqlite !== null) return sqlite;
  // Only try SQLite on Node; never on Workers/Edge (would blow up the bundle).
  if (typeof process === "undefined" || !process.versions || !process.versions.node) {
    sqlite = false;
    return false;
  }
  try {
    const mod = await import("better-sqlite3");
    const fs = await import("node:fs");
    const path = await import("node:path");
    const dir = process.env.DATA_DIR || path.join(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    db = new mod.default(path.join(dir, "atomic.db"));
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL,
        expires_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS pages (
        url TEXT PRIMARY KEY,
        title TEXT,
        text TEXT,
        host TEXT,
        indexed_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS pages_host_idx ON pages(host);
      CREATE INDEX IF NOT EXISTS pages_text_idx ON pages(text);
      CREATE TABLE IF NOT EXISTS crawl_queue (
        url TEXT PRIMARY KEY,
        added_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS submissions (
        url TEXT PRIMARY KEY,
        submitted_at INTEGER
      );
    `);
    sqlite = true;
    return true;
  } catch {
    sqlite = false;
    return false;
  }
}

const lru = new LRU(1000);

export async function cacheGet(key) {
  const mem = lru.get(key);
  if (mem && (!mem.expiresAt || mem.expiresAt > now())) return mem.value;
  if (mem) lru.delete(key);
  if (await tryLoadSqlite()) {
    const row = db.prepare("SELECT v, expires_at FROM kv WHERE k = ?").get(key);
    if (row && (!row.expires_at || row.expires_at > now())) {
      try {
        const value = JSON.parse(row.v);
        lru.set(key, { value, expiresAt: row.expires_at });
        return value;
      } catch {
        /* ignore */
      }
    }
  }
  return undefined;
}

export async function cacheSet(key, value, ttlMs = 15 * 60 * 1000) {
  const expiresAt = ttlMs ? now() + ttlMs : null;
  lru.set(key, { value, expiresAt });
  if (await tryLoadSqlite()) {
    db.prepare(
      "INSERT INTO kv(k, v, expires_at) VALUES(?, ?, ?) ON CONFLICT(k) DO UPDATE SET v=excluded.v, expires_at=excluded.expires_at"
    ).run(key, JSON.stringify(value), expiresAt);
  }
}

export async function insertPage({ url, title, text, host }) {
  if (!(await tryLoadSqlite())) return false;
  db.prepare(
    "INSERT OR REPLACE INTO pages(url, title, text, host, indexed_at) VALUES(?, ?, ?, ?, ?)"
  ).run(url, title || url, (text || "").slice(0, 4000), host || "", now());
  return true;
}

export async function searchPages(q, limit = 20) {
  if (!(await tryLoadSqlite())) return [];
  const like = `%${q}%`;
  const rows = db
    .prepare(
      `SELECT url, title, text, host FROM pages
       WHERE title LIKE ? OR text LIKE ?
       ORDER BY indexed_at DESC LIMIT ?`
    )
    .all(like, like, limit);
  return rows;
}

export async function addSubmission(url) {
  if (!(await tryLoadSqlite())) return false;
  db.prepare(
    "INSERT OR IGNORE INTO submissions(url, submitted_at) VALUES(?, ?)"
  ).run(url, now());
  db.prepare(
    "INSERT OR IGNORE INTO crawl_queue(url, added_at) VALUES(?, ?)"
  ).run(url, now());
  return true;
}

export async function nextCrawlTask() {
  if (!(await tryLoadSqlite())) return null;
  const row = db.prepare("SELECT url FROM crawl_queue ORDER BY added_at LIMIT 1").get();
  if (!row) return null;
  db.prepare("DELETE FROM crawl_queue WHERE url = ?").run(row.url);
  return row.url;
}

export async function enqueueCrawl(url) {
  if (!(await tryLoadSqlite())) return false;
  db.prepare(
    "INSERT OR IGNORE INTO crawl_queue(url, added_at) VALUES(?, ?)"
  ).run(url, now());
  return true;
}

export async function stats() {
  const base = { cacheEntries: lru.size(), persistent: false, pages: 0, queue: 0 };
  if (await tryLoadSqlite()) {
    base.persistent = true;
    base.pages = db.prepare("SELECT COUNT(*) AS c FROM pages").get().c;
    base.queue = db.prepare("SELECT COUNT(*) AS c FROM crawl_queue").get().c;
  }
  return base;
}

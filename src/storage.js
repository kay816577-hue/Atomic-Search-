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
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT UNIQUE NOT NULL,
        name TEXT,
        provider TEXT,
        sub TEXT,
        created_at INTEGER,
        last_login INTEGER
      );
      CREATE INDEX IF NOT EXISTS users_email_idx ON users(email);
      CREATE TABLE IF NOT EXISTS answers (
        q TEXT PRIMARY KEY,
        answer TEXT NOT NULL,
        mode TEXT,
        sources TEXT,
        created_at INTEGER,
        hit_count INTEGER DEFAULT 1
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
  const terms = (q || "")
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  if (!terms.length) return [];
  // Match if EVERY token appears in title OR text. Avoids giant OR fan-outs
  // while still catching partial matches across title+body.
  const where = terms.map(() => `(LOWER(title) LIKE ? OR LOWER(text) LIKE ?)`).join(" AND ");
  const params = [];
  for (const t of terms) {
    const like = `%${t}%`;
    params.push(like, like);
  }
  const rows = db
    .prepare(
      `SELECT url, title, text, host, indexed_at FROM pages
       WHERE ${where}
       ORDER BY indexed_at DESC LIMIT ?`
    )
    .all(...params, limit);
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

export async function upsertUser({ email, name, provider, sub }) {
  if (!(await tryLoadSqlite())) {
    // In-memory fallback so sessions at least work in this process.
    _memUsers = _memUsers || new Map();
    let u = _memUsers.get(email);
    if (!u) {
      u = { id: _memUsers.size + 1, email, name, provider, sub, created_at: now(), last_login: now() };
      _memUsers.set(email, u);
    } else {
      u.last_login = now();
      u.name = name || u.name;
      u.provider = provider || u.provider;
    }
    return u;
  }
  const existing = db.prepare("SELECT * FROM users WHERE email = ?").get(email);
  if (existing) {
    db.prepare("UPDATE users SET name = COALESCE(?, name), provider = COALESCE(?, provider), sub = COALESCE(?, sub), last_login = ? WHERE id = ?")
      .run(name || null, provider || null, sub || null, now(), existing.id);
    return db.prepare("SELECT * FROM users WHERE id = ?").get(existing.id);
  }
  const res = db.prepare("INSERT INTO users(email, name, provider, sub, created_at, last_login) VALUES(?, ?, ?, ?, ?, ?)")
    .run(email, name || null, provider || null, sub || null, now(), now());
  return db.prepare("SELECT * FROM users WHERE id = ?").get(res.lastInsertRowid);
}

export async function getUserById(id) {
  if (!(await tryLoadSqlite())) {
    if (!_memUsers) return null;
    for (const u of _memUsers.values()) if (u.id === Number(id)) return u;
    return null;
  }
  return db.prepare("SELECT * FROM users WHERE id = ?").get(Number(id)) || null;
}

export async function getUserByEmail(email) {
  if (!(await tryLoadSqlite())) return _memUsers ? _memUsers.get(email) || null : null;
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) || null;
}

let _memUsers = null;
let _memAnswers = null;

function normaliseQuery(q) {
  return (q || "").toLowerCase().replace(/\s+/g, " ").trim();
}

// Answer cache — key is the normalised query. Stored verbatim so repeat
// searches surface a pinned "Atomic answer" card before any meta results.
export async function getAnswer(q) {
  const key = normaliseQuery(q);
  if (!key) return null;
  if (await tryLoadSqlite()) {
    const row = db.prepare("SELECT answer, mode, sources, created_at, hit_count FROM answers WHERE q = ?").get(key);
    if (!row) return null;
    db.prepare("UPDATE answers SET hit_count = hit_count + 1 WHERE q = ?").run(key);
    let sources = [];
    try { sources = JSON.parse(row.sources || "[]"); } catch { /* ignore */ }
    return { query: q, answer: row.answer, mode: row.mode || "synthesis", sources, createdAt: row.created_at, hitCount: (row.hit_count || 0) + 1 };
  }
  if (!_memAnswers) return null;
  const row = _memAnswers.get(key);
  if (!row) return null;
  row.hitCount = (row.hitCount || 0) + 1;
  return { ...row, query: q };
}

export async function putAnswer(q, { answer, mode, sources }) {
  const key = normaliseQuery(q);
  if (!key || !answer) return false;
  if (await tryLoadSqlite()) {
    db.prepare(
      "INSERT INTO answers(q, answer, mode, sources, created_at, hit_count) VALUES(?, ?, ?, ?, ?, 1) " +
      "ON CONFLICT(q) DO UPDATE SET answer=excluded.answer, mode=excluded.mode, sources=excluded.sources, created_at=excluded.created_at"
    ).run(key, answer, mode || "synthesis", JSON.stringify(sources || []), now());
    return true;
  }
  _memAnswers = _memAnswers || new Map();
  _memAnswers.set(key, { answer, mode: mode || "synthesis", sources: sources || [], createdAt: now(), hitCount: 1 });
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

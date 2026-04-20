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
        added_at INTEGER,
        attempts INTEGER DEFAULT 0,
        next_attempt_at INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS dead_urls (
        url TEXT PRIMARY KEY,
        reason TEXT,
        died_at INTEGER
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
    // Soft migration for older DBs that predate the failure-tracking columns.
    // SQLite has no "ADD COLUMN IF NOT EXISTS", so we probe via pragma. This
    // has to run BEFORE we create the index that references next_attempt_at.
    try {
      const cols = db.prepare("PRAGMA table_info(crawl_queue)").all().map((r) => r.name);
      if (!cols.includes("attempts")) db.exec("ALTER TABLE crawl_queue ADD COLUMN attempts INTEGER DEFAULT 0");
      if (!cols.includes("next_attempt_at")) db.exec("ALTER TABLE crawl_queue ADD COLUMN next_attempt_at INTEGER DEFAULT 0");
    } catch { /* ignore */ }
    db.exec("CREATE INDEX IF NOT EXISTS crawl_queue_ready_idx ON crawl_queue(next_attempt_at);");
    sqlite = true;
    return true;
  } catch {
    sqlite = false;
    return false;
  }
}

const lru = new LRU(1000);

// Lifetime counters since process boot. These are NOT user data — they're
// aggregate health metrics (how many pages the crawler has written in this
// session, how many fresh pages we've seen). Exposed via /api/stats so the
// UI can show a live "cached / added / queue" chip.
const sessionStart = now();
let sessionAdded = 0;

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

// Patterns that identify low-value pages we should NOT index: error pages,
// login walls, captcha / bot-check pages, generic "home" or 404 placeholders.
// Matches are case-insensitive and anchored at word boundaries where it
// matters (so "logintrica" wouldn't false-positive on "login").
const INDEX_JUNK_TITLE_RE = /^(error|404|403|not found|access denied|forbidden|captcha|cloudflare|just a moment|attention required|sign in|log in|login|please wait|redirecting|loading\.{0,3}|home)\b/i;
const INDEX_JUNK_TEXT_HINTS = [
  "please enable javascript",
  "please enable cookies",
  "checking your browser",
  "verify you are human",
  "access to this page has been denied",
];

function shouldIndex(title, text) {
  const t = (title || "").trim();
  const b = (text || "").trim();
  // Reject thin pages (< 200 useful chars of body text). These are almost
  // always error pages, redirects, or pages behind a login wall.
  if (b.length < 200) return false;
  // Reject junk titles.
  if (INDEX_JUNK_TITLE_RE.test(t)) return false;
  // Reject bot-check / JS-required pages.
  const lower = b.toLowerCase();
  for (const hint of INDEX_JUNK_TEXT_HINTS) {
    if (lower.includes(hint) && b.length < 800) return false;
  }
  return true;
}

export async function insertPage({ url, title, text, host }) {
  if (!(await tryLoadSqlite())) return false;
  // Quality gate: keep the index lean. Callers fire-and-forget; a rejected
  // page simply doesn't land in the index instead of polluting search.
  if (!shouldIndex(title, text)) return false;
  const existed = db.prepare("SELECT 1 FROM pages WHERE url = ?").get(url);
  db.prepare(
    "INSERT OR REPLACE INTO pages(url, title, text, host, indexed_at) VALUES(?, ?, ?, ?, ?)"
  ).run(url, title || url, (text || "").slice(0, 4000), host || "", now());
  if (!existed) sessionAdded += 1;
  return true;
}

// One-shot prune: sweep rows that would fail shouldIndex() today. Used by
// the admin endpoint to clean up a messy index accumulated before the
// quality gate was in place.
export async function pruneIndex() {
  if (!(await tryLoadSqlite())) return { pruned: 0, remaining: 0 };
  const rows = db.prepare("SELECT url, title, text FROM pages").all();
  let pruned = 0;
  const del = db.prepare("DELETE FROM pages WHERE url = ?");
  for (const r of rows) {
    if (!shouldIndex(r.title, r.text)) {
      del.run(r.url);
      pruned += 1;
    }
  }
  const remaining = db.prepare("SELECT COUNT(*) AS n FROM pages").get().n || 0;
  return { pruned, remaining };
}

// Nuclear option: wipe the index entirely (pages + queue + dead). Useful
// when the user says "the index is a mess, start fresh". The cache and
// submissions are left alone — they're not "the index".
export async function clearIndex() {
  if (!(await tryLoadSqlite())) return false;
  db.exec(`
    DELETE FROM pages;
    DELETE FROM crawl_queue;
    DELETE FROM dead_urls;
  `);
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

// Pop the next crawl task. Respects next_attempt_at so a failing URL that's
// been backed off isn't re-tried until its cooldown has elapsed. URLs known
// dead (exceeded the retry budget) are skipped entirely.
export async function nextCrawlTask() {
  if (!(await tryLoadSqlite())) return null;
  const row = db
    .prepare(
      `SELECT q.url, q.attempts FROM crawl_queue q
       LEFT JOIN dead_urls d ON d.url = q.url
       WHERE d.url IS NULL AND (q.next_attempt_at IS NULL OR q.next_attempt_at <= ?)
       ORDER BY q.added_at LIMIT 1`
    )
    .get(now());
  if (!row) return null;
  // Hold onto attempts so the caller knows what retry-budget we're on.
  return { url: row.url, attempts: row.attempts || 0 };
}

export async function enqueueCrawl(url) {
  if (!(await tryLoadSqlite())) return false;
  const dead = db.prepare("SELECT 1 FROM dead_urls WHERE url = ?").get(url);
  if (dead) return false;
  db.prepare(
    "INSERT OR IGNORE INTO crawl_queue(url, added_at, attempts, next_attempt_at) VALUES(?, ?, 0, 0)"
  ).run(url, now());
  return true;
}

// Successful fetch — drop from queue (already crawled or now in pages).
export async function dropFromQueue(url) {
  if (!(await tryLoadSqlite())) return false;
  db.prepare("DELETE FROM crawl_queue WHERE url = ?").run(url);
  return true;
}

// Per-URL retry with exponential backoff, capped at a reasonable ceiling.
// After MAX_CRAWL_ATTEMPTS the URL is considered dead — pruned from pages
// and recorded in dead_urls so we don't try it again.
const MAX_CRAWL_ATTEMPTS = 5;
const BACKOFF_BASE_MS = 60 * 1000; // 1 min

export async function recordCrawlFailure(url, reason) {
  if (!(await tryLoadSqlite())) return { dead: false };
  const row = db.prepare("SELECT attempts FROM crawl_queue WHERE url = ?").get(url);
  const attempts = (row?.attempts || 0) + 1;
  if (attempts >= MAX_CRAWL_ATTEMPTS) {
    db.prepare("DELETE FROM crawl_queue WHERE url = ?").run(url);
    db.prepare("DELETE FROM pages WHERE url = ?").run(url);
    db.prepare(
      "INSERT OR REPLACE INTO dead_urls(url, reason, died_at) VALUES(?, ?, ?)"
    ).run(url, (reason || "unknown").toString().slice(0, 160), now());
    return { dead: true, attempts };
  }
  // Exponential backoff: 1m, 4m, 16m, 64m (capped by MAX_CRAWL_ATTEMPTS).
  const cooldown = BACKOFF_BASE_MS * Math.pow(4, attempts - 1);
  const next = now() + cooldown;
  if (row) {
    db.prepare("UPDATE crawl_queue SET attempts = ?, next_attempt_at = ? WHERE url = ?")
      .run(attempts, next, url);
  } else {
    // Shouldn't normally happen (we took it out of the queue), but re-add so
    // the retry actually fires.
    db.prepare(
      "INSERT OR REPLACE INTO crawl_queue(url, added_at, attempts, next_attempt_at) VALUES(?, ?, ?, ?)"
    ).run(url, now(), attempts, next);
  }
  return { dead: false, attempts, retryInMs: cooldown };
}

// Re-enqueue pages older than `olderThanMs`. Used by the janitor so our index
// stays fresh without us having to manually re-submit every URL.
export async function reenqueueStale(olderThanMs = 14 * 24 * 3600 * 1000, limit = 50) {
  if (!(await tryLoadSqlite())) return 0;
  const cutoff = now() - olderThanMs;
  const rows = db
    .prepare("SELECT url FROM pages WHERE (indexed_at IS NULL OR indexed_at < ?) ORDER BY indexed_at ASC LIMIT ?")
    .all(cutoff, limit);
  let n = 0;
  for (const r of rows) {
    const dead = db.prepare("SELECT 1 FROM dead_urls WHERE url = ?").get(r.url);
    if (dead) continue;
    db.prepare(
      "INSERT OR IGNORE INTO crawl_queue(url, added_at, attempts, next_attempt_at) VALUES(?, ?, 0, 0)"
    ).run(r.url, now());
    n += 1;
  }
  return n;
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
  const base = {
    cacheEntries: lru.size(),
    persistent: false,
    pages: 0,
    queue: 0,
    queueReady: 0,
    queueBackoff: 0,
    dead: 0,
    answers: 0,
    added: sessionAdded,
    uptimeMs: now() - sessionStart,
  };
  if (await tryLoadSqlite()) {
    base.persistent = true;
    base.pages = db.prepare("SELECT COUNT(*) AS c FROM pages").get().c;
    base.queue = db.prepare("SELECT COUNT(*) AS c FROM crawl_queue").get().c;
    base.queueReady = db.prepare("SELECT COUNT(*) AS c FROM crawl_queue WHERE next_attempt_at IS NULL OR next_attempt_at <= ?").get(now()).c;
    base.queueBackoff = base.queue - base.queueReady;
    base.dead = db.prepare("SELECT COUNT(*) AS c FROM dead_urls").get().c;
    base.answers = db.prepare("SELECT COUNT(*) AS c FROM answers").get().c;
  }
  return base;
}

// src/storage.js — SQLite cache + FTS + optional local index
import Database from "better-sqlite3";
import { nanoid } from "nanoid";
import fs from "node:fs";
import path from "node:path";
import { isNsfwText } from "./nsfw.js";

const DB_PATH = process.env.DB_PATH || "/tmp/atomic-search.db";
const READONLY = !!process.env.READ_ONLY_INDEX;
const INDEX_FILE = process.env.INDEX_FILE || null;

let db = null;

function ensureDir(p) {
  try { fs.mkdirSync(path.dirname(p), { recursive: true }); } catch {}
}

function init() {
  if (db) return db;
  ensureDir(DB_PATH);
  db = new Database(DB_PATH, { readonly: READONLY });

  // PRAGMA's voor performance - CORRECTE VERSIE
  if (!READONLY) {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("cache_size = -64000");   // ~64 MB page cache
    db.pragma("temp_store = MEMORY");
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS pages (
      id TEXT PRIMARY KEY,
      url TEXT UNIQUE NOT NULL,
      host TEXT,
      title TEXT,
      text TEXT,
      fetched_at INTEGER,
      rank REAL DEFAULT 0
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
      title, text, content='pages', content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS pages_ai AFTER INSERT ON pages BEGIN
      INSERT INTO pages_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
    END;

    CREATE TRIGGER IF NOT EXISTS pages_ad AFTER DELETE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, title, text) VALUES('delete', old.rowid, old.title, old.text);
    END;

    CREATE TRIGGER IF NOT EXISTS pages_au AFTER UPDATE ON pages BEGIN
      INSERT INTO pages_fts(pages_fts, rowid, title, text) VALUES('delete', old.rowid, old.title, old.text);
      INSERT INTO pages_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
    END;
  `);

  return db;
}

export function getDb() {
  return init();
}

export function putPage({ url, host, title, text, rank = 0 }) {
  if (!url || isNsfwText(title) || isNsfwText(text)) return null;
  const d = getDb();
  const id = nanoid();
  const stmt = d.prepare(`
    INSERT INTO pages (id, url, host, title, text, fetched_at, rank)
    VALUES (@id, @url, @host, @title, @text, @fetched_at, @rank)
    ON CONFLICT(url) DO UPDATE SET
      host=excluded.host,
      title=excluded.title,
      text=excluded.text,
      fetched_at=excluded.fetched_at,
      rank=excluded.rank
  `);
  stmt.run({
    id,
    url,
    host: host || null,
    title: title || "",
    text: text || "",
    fetched_at: Date.now(),
    rank
  });
  return id;
}

export function searchIndex(query, { limit = 100 } = {}) {
  if (!query || !query.trim()) return [];
  const d = getDb();
  const q = query.trim();
  const stmt = d.prepare(`
    SELECT p.url, p.host, p.title, p.text, p.rank, bm25(pages_fts) as score
    FROM pages_fts
    JOIN pages p ON pages_fts.rowid = p.rowid
    WHERE pages_fts MATCH ?
    ORDER BY score
    LIMIT ?
  `);
  const rows = stmt.all(q, limit);
  return rows.map(r => ({
    url: r.url,
    host: r.host,
    title: r.title,
    snippet: (r.text || "").slice(0, 300),
    text: r.text,
    ownIndex: true,
    score: r.score,
    rank: r.rank
  }));
}

export function loadIndexFromFile() {
  if (!INDEX_FILE) return { loaded: 0 };
  try {
    const raw = fs.readFileSync(INDEX_FILE, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return { loaded: 0 };
    let n = 0;
    for (const doc of arr) {
      if (!doc?.url) continue;
      putPage({
        url: doc.url,
        host: doc.host || new URL(doc.url).hostname,
        title: doc.title || "",
        text: doc.text || doc.content || "",
        rank: doc.rank || 0
      });
      n++;
    }
    return { loaded: n };
  } catch {
    return { loaded: 0, error: "failed" };
  }
}

export function indexStats() {
  const d = getDb();
  const { n } = d.prepare("SELECT COUNT(*) as n FROM pages").get();
  return { pages: n, readonly: READONLY };
}

// Persistent index sync — commits the growing SQLite crawler DB back to a
// dedicated git branch (default `atomic-search-index`) so the index survives
// Render free-tier restarts, which wipe the disk on every redeploy and
// spin-down. This uses only the git binary + HTTPS Basic auth with a
// GitHub PAT, so there's no runtime dependency on any external storage
// service.
//
// Env vars (all optional — the module no-ops if required ones are missing):
//   GH_INDEX_PAT       GitHub PAT with contents:write on the repo.
//   GH_INDEX_REPO      owner/repo (default derived from GITHUB_REPOSITORY or
//                       GH_REPO, falling back to "kayan4bit/Atomic-Search-").
//   GH_INDEX_BRANCH    Branch to push index snapshots to (default
//                       "atomic-search-index").
//   DATA_DIR           Where the live SQLite DB lives (default ./data).
//   GH_INDEX_INTERVAL  Push interval in seconds (default 600 = 10 min).
//   GH_INDEX_USER      Committer name (default "atomic-search-bot").
//   GH_INDEX_EMAIL     Committer email (default "atomic-search-bot@users.noreply.github.com").

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_REPO = "kayan4bit/Atomic-Search-";
const DEFAULT_BRANCH = "atomic-search-index";
const INDEX_FILE = "atomic.db";
// Files the crawler might produce alongside the main DB (WAL/SHM).
const SQLITE_COMPANIONS = ["atomic.db-wal", "atomic.db-shm"];

let started = false;
let syncing = false;
// Manual-trigger hook set by startIndexSync(); requestSnapshot() uses it to
// kick a push without re-cloning. Declared here (not below the function
// that assigns it) so editors / linters don't flag a forward reference.
let manualTrigger = null;

function env(name, fallback) {
  if (typeof process === "undefined" || !process.env) return fallback;
  const v = process.env[name];
  return v == null || v === "" ? fallback : v;
}

function log(...args) {
  // Deliberately one-line, no PII.
  console.log("[index-sync]", ...args);
}

function runGit(args, { cwd, env: extraEnv } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, ...extraEnv, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function getConfig() {
  const token = env("GH_INDEX_PAT", "");
  if (!token) return null;
  let repo = env("GH_INDEX_REPO", "") || env("GITHUB_REPOSITORY", "") || env("GH_REPO", "") || DEFAULT_REPO;
  repo = repo.replace(/^https?:\/\/github.com\//i, "").replace(/\.git$/i, "");
  const branch = env("GH_INDEX_BRANCH", DEFAULT_BRANCH);
  const interval = Math.max(60, Number(env("GH_INDEX_INTERVAL", "600")) || 600) * 1000;
  const dataDir = path.resolve(env("DATA_DIR", path.join(process.cwd(), "data")));
  const userName = env("GH_INDEX_USER", "atomic-search-bot");
  const userEmail = env("GH_INDEX_EMAIL", "atomic-search-bot@users.noreply.github.com");
  // Never embed tokens in URLs checked into history. We use Basic-auth via
  // the `http.extraheader` config so `git remote -v` stays clean.
  const remote = `https://github.com/${repo}.git`;
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return { token, repo, branch, interval, dataDir, userName, userEmail, remote, basic };
}

async function ensureRepo(cfg) {
  const workDir = path.join(os.tmpdir(), "atomic-index-" + cfg.repo.replace(/[^a-z0-9]+/gi, "-"));
  const gitDir = path.join(workDir, ".git");
  const extraHeader = `http.extraheader=AUTHORIZATION: basic ${cfg.basic}`;

  const cloneArgs = [
    "-c", extraHeader,
    "clone", "--depth", "1", "--single-branch",
    "--branch", cfg.branch,
    cfg.remote, workDir,
  ];

  if (!fs.existsSync(gitDir)) {
    log("cloning data branch", cfg.branch);
    const res = await runGit(cloneArgs);
    if (res.code !== 0) {
      // Likely the branch doesn't exist yet — create it as an orphan below.
      log("clone failed, creating new orphan branch:", (res.stderr || "").split("\n").pop());
      await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
      await fsp.mkdir(workDir, { recursive: true });
      await runGit(["init", "-b", cfg.branch], { cwd: workDir });
      await runGit(["remote", "add", "origin", cfg.remote], { cwd: workDir });
      await fsp.writeFile(
        path.join(workDir, "README.md"),
        "# Atomic Search — persistent crawl index\n\n" +
          "This branch stores `atomic.db`, the SQLite crawl index for\n" +
          `[${cfg.repo}](https://github.com/${cfg.repo}). It's written by the\n` +
          "running server and restored on every cold start.\n"
      );
    }
  } else {
    log("fetching data branch", cfg.branch);
    await runGit(["-c", extraHeader, "fetch", "--depth", "1", "origin", cfg.branch], { cwd: workDir });
    await runGit(["checkout", cfg.branch], { cwd: workDir }).catch(() => {});
    await runGit(["-c", extraHeader, "reset", "--hard", `origin/${cfg.branch}`], { cwd: workDir });
  }

  await runGit(["config", "user.name", cfg.userName], { cwd: workDir });
  await runGit(["config", "user.email", cfg.userEmail], { cwd: workDir });

  return { workDir, extraHeader };
}

async function copyIfExists(src, dst) {
  try {
    await fsp.copyFile(src, dst);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pulls the latest snapshot from the data branch into DATA_DIR.
 *
 * Called BEFORE the HTTP server starts serving and before the crawler ever
 * opens the DB — so we can always overwrite the local DATA_DIR without
 * fear of racing with a writer. This is critical on Render's free tier:
 * every deploy wipes the filesystem, so if we didn't overwrite here the
 * crawler would happily boot against an empty DB and the next periodic
 * push would wipe the remote snapshot too.
 */
async function restoreIntoDataDir(cfg, workDir) {
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  const snap = path.join(workDir, INDEX_FILE);
  if (!fs.existsSync(snap)) {
    log("no snapshot in data branch yet — starting fresh");
    return false;
  }
  const snapStat = await fsp.stat(snap).catch(() => null);
  if (!snapStat || snapStat.size === 0) {
    log("snapshot file is empty — skipping restore");
    return false;
  }
  const dst = path.join(cfg.dataDir, INDEX_FILE);
  // Prefer the snapshot over whatever happens to be on disk. If the local
  // DB is larger (e.g. running locally with real data), keep it — but for
  // free-tier Render, `dst` is gone after every deploy so the snapshot
  // always wins.
  let localSize = 0;
  try {
    if (fs.existsSync(dst)) localSize = (await fsp.stat(dst)).size;
  } catch { /* ignore */ }
  if (localSize > snapStat.size) {
    log(
      `live DB (${localSize}B) larger than snapshot (${snapStat.size}B) — keeping local`
    );
    return false;
  }
  // Wipe any stale WAL/SHM the new snapshot might be inconsistent with.
  for (const f of SQLITE_COMPANIONS) {
    try { await fsp.unlink(path.join(cfg.dataDir, f)); } catch { /* ignore */ }
  }
  await fsp.copyFile(snap, dst);
  // Also restore companions if the snapshot has them.
  for (const f of SQLITE_COMPANIONS) {
    await copyIfExists(path.join(workDir, f), path.join(cfg.dataDir, f));
  }
  log(`restored index snapshot from data branch (${snapStat.size}B)`);
  return true;
}

// Returns the size of the last-known-good snapshot in the working clone,
// used as a floor when deciding whether to push a new snapshot. Never
// overwrite a fatter remote snapshot with a near-empty local one.
async function snapshotSize(workDir) {
  try {
    const s = await fsp.stat(path.join(workDir, INDEX_FILE));
    return s.size || 0;
  } catch {
    return 0;
  }
}

/**
 * Copies the live SQLite DB into the working clone and commits/pushes it.
 */
async function pushSnapshot(cfg, workDir, extraHeader) {
  if (syncing) return;
  syncing = true;
  try {
    const live = path.join(cfg.dataDir, INDEX_FILE);
    if (!fs.existsSync(live)) return;
    const liveStat = await fsp.stat(live).catch(() => null);
    if (!liveStat || liveStat.size === 0) {
      log("live DB is empty — refusing to push (would wipe remote snapshot)");
      return;
    }
    // Safety valve: if the last-known-good snapshot on the data branch is
    // substantially larger than what we're about to push, something has
    // gone wrong locally (fresh boot, crash-truncated DB, etc.) — refuse
    // to regress the remote snapshot. Tolerate a small shrink (<10%) to
    // handle VACUUM / pruning.
    const remoteSize = await snapshotSize(workDir);
    if (remoteSize > 0 && liveStat.size < remoteSize * 0.9) {
      log(
        `live DB (${liveStat.size}B) is smaller than remote snapshot ` +
        `(${remoteSize}B) — refusing regression`
      );
      return;
    }
    // Copy main DB + SQLite WAL companions so the snapshot is consistent.
    await copyIfExists(live, path.join(workDir, INDEX_FILE));
    for (const f of SQLITE_COMPANIONS) {
      await copyIfExists(path.join(cfg.dataDir, f), path.join(workDir, f));
    }

    await runGit(["add", INDEX_FILE, ...SQLITE_COMPANIONS], { cwd: workDir });
    const status = await runGit(["status", "--porcelain"], { cwd: workDir });
    if (!status.stdout.trim()) return; // nothing changed

    const msg = `snapshot: atomic.db ${new Date().toISOString()}`;
    const commit = await runGit(["commit", "-m", msg], { cwd: workDir });
    if (commit.code !== 0) {
      log("commit failed:", (commit.stderr || "").split("\n").pop());
      return;
    }
    const push = await runGit(
      ["-c", extraHeader, "push", "--set-upstream", "origin", cfg.branch],
      { cwd: workDir }
    );
    if (push.code !== 0) {
      log("push failed:", (push.stderr || "").split("\n").pop());
      return;
    }
    log("snapshot pushed");
  } finally {
    syncing = false;
  }
}

/**
 * Public: restores index on boot and schedules periodic snapshot pushes.
 * Safe to call in any environment — no-ops when no PAT is configured.
 */
export async function startIndexSync() {
  if (started) return;
  started = true;
  const cfg = getConfig();
  if (!cfg) {
    log("GH_INDEX_PAT not set — index will not be persisted across restarts");
    return;
  }
  try {
    const { workDir, extraHeader } = await ensureRepo(cfg);
    await restoreIntoDataDir(cfg, workDir);

    // Schedule periodic snapshots.
    const tick = async () => {
      try {
        await pushSnapshot(cfg, workDir, extraHeader);
      } catch (e) {
        log("tick error:", e?.message || e);
      }
    };
    setInterval(tick, cfg.interval).unref?.();

    // Expose a manual "push now" hook the admin endpoint can call when the
    // user submits a site or the crawler just indexed a batch of new pages
    // (so the snapshot reflects reality immediately, not up to 10 minutes
    // later).
    manualTrigger = tick;

    // Flush on graceful shutdown so we don't lose late writes.
    const flush = () => {
      tick().finally(() => process.exit(0));
    };
    process.once("SIGTERM", flush);
    process.once("SIGINT", flush);
  } catch (e) {
    log("sync init failed:", e?.message || e);
  }
}

/**
 * Kick a snapshot push using the already-initialised working clone, if
 * there is one. Much cheaper than `forceSnapshot` (which re-clones).
 * Returns true if a tick was kicked, false otherwise.
 */
export async function requestSnapshot() {
  if (!manualTrigger) return false;
  try {
    await manualTrigger();
    return true;
  } catch {
    return false;
  }
}

/**
 * Force a snapshot now — useful from an admin endpoint. Returns false if
 * sync isn't configured, true otherwise (regardless of whether anything
 * actually needed pushing).
 */
export async function forceSnapshot() {
  const cfg = getConfig();
  if (!cfg) return false;
  try {
    const { workDir, extraHeader } = await ensureRepo(cfg);
    await pushSnapshot(cfg, workDir, extraHeader);
    return true;
  } catch (e) {
    log("forceSnapshot failed:", e?.message || e);
    return false;
  }
}

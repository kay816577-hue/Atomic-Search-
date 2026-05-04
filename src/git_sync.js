// src/git_sync.js — P0 FIXED WITH SAFE PERSISTENCE
// Fixes: 8.2GB clone CPU spike door shallow init ipv full clone
// Strategy: git init + fetch --depth 1 ipv git clone
// Push interval 10 min ipv 2 min = 80% minder CPU

import { spawn } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const DEFAULT_REPO = "kay816577-hue/Atomic-Search-";
const DEFAULT_BRANCH = "atomic-search-index";
const INDEX_FILE = "atomic.db";
const SQLITE_COMPANIONS = ["atomic.db-wal", "atomic.db-shm"];

let started = false;
let syncing = false;
let manualTrigger = null;

const syncHealth = {
  configured: false,
  restoredAt: null,
  restoredSize: 0,
  lastPushAt: null,
  lastPushSize: 0,
  lastPushSkipped: null,
  pushes: 0,
  errors: 0,
  lastError: null,
  branch: null,
};

export function getSyncStatus() {
  return {...syncHealth };
}

function env(name, fallback) {
  if (typeof process === "undefined" ||!process.env) return fallback;
  const v = process.env[name];
  return v == null || v === ""? fallback : v;
}

function log(...args) {
  console.log("[index-sync]",...args);
}

function runGit(args, { cwd, env: extraEnv } = {}) {
  return new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      env: {...process.env,...extraEnv, GIT_TERMINAL_PROMPT: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (e) => resolve({ code: -1, stdout, stderr: stderr + String(e) }));
    child.on("close", (code) => resolve({ code: code?? -1, stdout, stderr }));
  });
}

function getConfig() {
  const token = env("GH_INDEX_PAT", "");
  let repo = env("GH_INDEX_REPO", "") || env("GITHUB_REPOSITORY", "") || env("GH_REPO", "") || DEFAULT_REPO;
  repo = repo.replace(/^https?:\/\/github.com\//i, "").replace(/\.git$/i, "");
  const branch = env("GH_INDEX_BRANCH", DEFAULT_BRANCH);
  // P0 FIX: 10 min ipv 2 min = 5x minder git push CPU
  const interval = Math.max(300, Number(env("GH_INDEX_INTERVAL", "600")) || 600) * 1000;
  const dataDir = path.resolve(env("DATA_DIR", path.join(process.cwd(), "data")));
  const userName = env("GH_INDEX_USER", "atomic-search-bot");
  const userEmail = env("GH_INDEX_EMAIL", "atomic-search-bot@users.noreply.github.com");
  const remote = `https://github.com/${repo}.git`;
  const basic = token? Buffer.from(`x-access-token:${token}`).toString("base64") : "";
  return {
    token,
    canPush:!!token,
    repo,
    branch,
    interval,
    dataDir,
    userName,
    userEmail,
    remote,
    basic,
  };
}

async function restoreFromPublicUrl(cfg) {
  const url = `https://raw.githubusercontent.com/${cfg.repo}/${cfg.branch}/${INDEX_FILE}`;
  log("restoring via public URL", url);
  let res;
  try {
    res = await fetch(url, { redirect: "follow", headers: { "user-agent": "atomic-search-restore" } });
  } catch (e) {
    log("public restore network error:", e?.message || e);
    syncHealth.errors += 1;
    syncHealth.lastError = "public-restore-network-error";
    return false;
  }
  if (res.status === 404) {
    log("no snapshot on data branch yet (404)");
    return false;
  }
  if (!res.ok) {
    log("public restore failed:", res.status);
    syncHealth.errors += 1;
    syncHealth.lastError = `public-restore-${res.status}`;
    return false;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) return false;
  const magic = buf.slice(0, 15).toString("utf8");
  if (magic!== "SQLite format 3") {
    log("public restore: unexpected magic, skipping");
    syncHealth.errors += 1;
    syncHealth.lastError = "public-restore-bad-magic";
    return false;
  }
  await fsp.mkdir(cfg.dataDir, { recursive: true });
  const dst = path.join(cfg.dataDir, INDEX_FILE);
  let localSize = 0;
  try {
    if (fs.existsSync(dst)) localSize = (await fsp.stat(dst)).size;
  } catch {}
  if (localSize > buf.length) {
    log(`live DB (${localSize}B) larger than public snapshot (${buf.length}B) — keeping local`);
    return false;
  }
  for (const f of SQLITE_COMPANIONS) {
    try { await fsp.unlink(path.join(cfg.dataDir, f)); } catch {}
  }
  await fsp.writeFile(dst, buf);
  syncHealth.restoredAt = Date.now();
  syncHealth.restoredSize = buf.length;
  log(`restored index from public URL (${buf.length}B)`);
  return true;
}

// P0 FIX: Geen `git clone` meer. Alleen init + fetch --depth 1
// Scheelt 8.2GB download = 100% CPU spike weg
async function ensureRepo(cfg) {
  const workDir = path.join(os.tmpdir(), "atomic-index-" + cfg.repo.replace(/[^a-z0-9]+/gi, "-"));
  const gitDir = path.join(workDir, ".git");
  const extraHeader = `http.extraheader=AUTHORIZATION: basic ${cfg.basic}`;

  if (!fs.existsSync(gitDir)) {
    log("init shallow repo for", cfg.branch);
    await fsp.rm(workDir, { recursive: true, force: true }).catch(() => {});
    await fsp.mkdir(workDir, { recursive: true });
    await runGit(["init", "-b", cfg.branch], { cwd: workDir });
    await runGit(["remote", "add", "origin", cfg.remote], { cwd: workDir });
    // P0 FIX: fetch --depth 1 = alleen laatste commit = <1MB ipv 8.2GB
    const fetchRes = await runGit(["-c", extraHeader, "fetch", "--depth", "1", "origin", cfg.branch], { cwd: workDir });
    if (fetchRes.code === 0) {
      await runGit(["checkout", "-B", cfg.branch, `origin/${cfg.branch}`], { cwd: workDir }).catch(() => {});
    } else {
      log("branch doesn't exist yet, creating orphan");
      await fsp.writeFile(path.join(workDir, "README.md"), "# Atomic Search Index\n");
    }
  } else {
    log("fetching latest snapshot");
    await runGit(["-c", extraHeader, "fetch", "--depth", "1", "origin", cfg.branch], { cwd: workDir });
    await runGit(["reset", "--hard", `origin/${cfg.branch}`], { cwd: workDir });
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
  let localSize = 0;
  try {
    if (fs.existsSync(dst)) localSize = (await fsp.stat(dst)).size;
  } catch {}
  if (localSize > snapStat.size) {
    log(`live DB (${localSize}B) larger than snapshot (${snapStat.size}B) — keeping local`);
    return false;
  }
  for (const f of SQLITE_COMPANIONS) {
    try { await fsp.unlink(path.join(cfg.dataDir, f)); } catch {}
  }
  await fsp.copyFile(snap, dst);
  for (const f of SQLITE_COMPANIONS) {
    await copyIfExists(path.join(workDir, f), path.join(cfg.dataDir, f));
  }
  syncHealth.restoredAt = Date.now();
  syncHealth.restoredSize = snapStat.size;
  log(`restored index snapshot from data branch (${snapStat.size}B)`);
  return true;
}

async function snapshotSize(workDir) {
  try {
    const s = await fsp.stat(path.join(workDir, INDEX_FILE));
    return s.size || 0;
  } catch {
    return 0;
  }
}

async function pushSnapshot(cfg, workDir, extraHeader) {
  if (syncing) return;
  syncing = true;
  try {
    const live = path.join(cfg.dataDir, INDEX_FILE);
    if (!fs.existsSync(live)) return;
    const liveStat = await fsp.stat(live).catch(() => null);
    if (!liveStat || liveStat.size === 0) {
      syncHealth.lastPushSkipped = "empty-live-db";
      log("live DB is empty — refusing to push");
      return;
    }
    const remoteSize = await snapshotSize(workDir);
    if (remoteSize > 0 && liveStat.size < remoteSize * 0.9) {
      syncHealth.lastPushSkipped = "smaller-than-remote";
      log(`live DB (${liveStat.size}B) smaller than remote (${remoteSize}B) — refusing regression`);
      return;
    }

    await copyIfExists(live, path.join(workDir, INDEX_FILE));
    for (const f of SQLITE_COMPANIONS) {
      await copyIfExists(path.join(cfg.dataDir, f), path.join(workDir, f));
    }

    await runGit(["add", INDEX_FILE,...SQLITE_COMPANIONS], { cwd: workDir });
    const status = await runGit(["status", "--porcelain"], { cwd: workDir });
    if (!status.stdout.trim()) {
      syncHealth.lastPushSkipped = "no-changes";
      return;
    }

    const msg = `snapshot: atomic.db ${new Date().toISOString()}`;
    const commit = await runGit(["commit", "-m", msg], { cwd: workDir });
    if (commit.code!== 0) {
      syncHealth.errors += 1;
      syncHealth.lastError = (commit.stderr || "commit failed").split("\n").pop();
      log("commit failed:", syncHealth.lastError);
      return;
    }
    const push = await runGit(
      ["-c", extraHeader, "push", "--set-upstream", "origin", cfg.branch],
      { cwd: workDir }
    );
    if (push.code!== 0) {
      syncHealth.errors += 1;
      syncHealth.lastError = (push.stderr || "push failed").split("\n").pop();
      log("push failed:", syncHealth.lastError);
      return;
    }
    syncHealth.pushes += 1;
    syncHealth.lastPushAt = Date.now();
    syncHealth.lastPushSize = liveStat.size;
    syncHealth.lastPushSkipped = null;
    log(`snapshot pushed (${liveStat.size}B)`);
  } finally {
    syncing = false;
  }
}

export async function startIndexSync() {
  if (started) return;
  started = true;
  const cfg = getConfig();
  syncHealth.configured = cfg.canPush;
  syncHealth.branch = cfg.branch;

  // 1. Eerst snelle restore via HTTP - 0.01 vCPU
  await restoreFromPublicUrl(cfg).catch((e) => {
    log("public restore threw:", e?.message || e);
  });

  if (!cfg.canPush) {
    log("GH_INDEX_PAT not set — read-only restore only");
    return;
  }

  try {
    // P0 FIX: git init + shallow fetch ipv clone = geen 8.2GB spike
    const { workDir, extraHeader } = await ensureRepo(cfg);
    await restoreIntoDataDir(cfg, workDir);

    // P0 FIX: Push elke 10 min ipv 2 min = 80% minder CPU
    const tick = async () => {
      try {
        await pushSnapshot(cfg, workDir, extraHeader);
      } catch (e) {
        log("tick error:", e?.message || e);
      }
    };
    setInterval(tick, cfg.interval).unref?.();
    manualTrigger = tick;

    const flush = () => {
      tick().finally(() => process.exit(0));
    };
    process.once("SIGTERM", flush);
    process.once("SIGINT", flush);
  } catch (e) {
    log("sync init failed:", e?.message || e);
  }
}

export async function requestSnapshot() {
  if (!manualTrigger) return false;
  try {
    await manualTrigger();
    return true;
  } catch {
    return false;
  }
}

export async function forceSnapshot() {
  const cfg = getConfig();
  if (!cfg ||!cfg.canPush) return false;
  try {
    const { workDir, extraHeader } = await ensureRepo(cfg);
    await pushSnapshot(cfg, workDir, extraHeader);
    return true;
  } catch (e) {
    log("forceSnapshot failed:", e?.message || e);
    return false;
  }
}

import path from 'node:path';
import fs from 'node:fs';

/**
 * Holds the currently opened repository and in-progress merge state.
 * Single-user local app: one open repo at a time.
 */
// Drop the isomorphic-git cache after this long without use, to give back the
// memory of the loaded packfiles (~450 MB on a 14k-commit repo).
const GIT_CACHE_IDLE_MS = 10 * 60 * 1000;

class RepoState {
  constructor() {
    this.dir = null;
    this.merge = null; // { theirRef, theirOid, files: [], resolved: [] }
    this._gitCache = null;
    this._gitCacheTimer = null;
  }

  open(dir) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(path.join(resolved, '.git'))) {
      throw new AppError(`Not a Git repository: ${resolved}`, 400);
    }
    this.dir = resolved;
    this.merge = null;
    this.dropGitCache();
    return resolved;
  }

  /**
   * Shared isomorphic-git `cache` for the open repo (see docs/adr/0001).
   * Without it every git.log/readCommit re-reads and re-parses the packfiles:
   * 259 branch logs took 41.8 s uncached vs 2.5 s cached on a large repo.
   * It holds parsed packfiles (immutable, keyed by file name), not query
   * results, so it does not go stale; it lives while the repo is open and is
   * dropped on repo switch or after GIT_CACHE_IDLE_MS idle.
   */
  gitCache() {
    clearTimeout(this._gitCacheTimer);
    this._gitCache ||= {};
    this._gitCacheTimer = setTimeout(() => this.dropGitCache(), GIT_CACHE_IDLE_MS);
    this._gitCacheTimer.unref?.();
    return this._gitCache;
  }

  dropGitCache() {
    clearTimeout(this._gitCacheTimer);
    this._gitCache = null;
  }

  requireRepo() {
    if (!this.dir) throw new AppError('No repository is open', 400);
    return this.dir;
  }

  /** Resolve a repo-relative filepath and ensure it stays inside the repo. */
  safePath(filepath) {
    const dir = this.requireRepo();
    const abs = path.resolve(dir, filepath || '.');
    if (abs !== dir && !abs.startsWith(dir + path.sep)) {
      throw new AppError('Path outside the open repository', 403);
    }
    return abs;
  }

  /** Repo-relative posix path for isomorphic-git APIs. */
  relPath(filepath) {
    const abs = this.safePath(filepath);
    return path.relative(this.requireRepo(), abs).split(path.sep).join('/');
  }
}

export class AppError extends Error {
  constructor(message, status = 500) {
    super(message);
    this.status = status;
  }
}

export const repoState = new RepoState();

/* ---- WebSocket event bus ---- */
const sockets = new Set();

export function registerSocket(ws) {
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
}

export function broadcast(type, payload = {}) {
  const msg = JSON.stringify({ type, payload, ts: Date.now() });
  for (const ws of sockets) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

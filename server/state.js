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
    this.graphWalk = null; // { id, walk: GraphWalk } — the paged graph in progress
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
    // isomorphic-git caches "no index" for a repo whose .git/index does not
    // exist yet (fresh `git init`) and never notices when it appears, so the
    // first commit saw nothing staged. Until the index exists, hand out a
    // throwaway cache — there are no packfiles to reuse yet anyway.
    if (!fs.existsSync(path.join(this.requireRepo(), '.git', 'index'))) return {};
    clearTimeout(this._gitCacheTimer);
    this._gitCache ||= {};
    this._gitCacheTimer = setTimeout(() => this.dropGitCache(), GIT_CACHE_IDLE_MS);
    this._gitCacheTimer.unref?.();
    return this._gitCache;
  }

  dropGitCache() {
    clearTimeout(this._gitCacheTimer);
    this._gitCache = null;
    this.graphWalk = null; // its heap holds commits read through that cache
  }

  requireRepo() {
    if (!this.dir) throw new AppError('No repository is open', 400);
    return this.dir;
  }

  /** Resolve a repo-relative filepath and ensure it stays inside the repo. */
  /**
   * Absolute path for a repo-relative `filepath`, refusing anything that ends
   * up outside the repo or inside .git/ (BACKLOG B-09, B-13):
   * - lexically (`../`), as before;
   * - through a symlinked directory on the way (`link/secret.txt`, where
   *   `link -> ~/.ssh` came with a cloned repo): the parent's real path must
   *   be inside the repo;
   * - with `follow: true` (operations that read or write the CONTENT), the
   *   final component too: a link to a file or directory outside, or a
   *   dangling link (writing would create its target), is refused.
   * Without `follow`, a symlink entry itself stays usable (stage, discard):
   * git versions the link, not what it points to.
   */
  safePath(filepath, { follow = false } = {}) {
    const dir = this.requireRepo();
    const outside = () => new AppError('Path outside the open repository', 403);
    const abs = path.resolve(dir, filepath || '.');
    if (abs === dir) return abs;
    if (!abs.startsWith(dir + path.sep)) throw outside();
    // .git holds config (remote URLs → where tokens go), hooks and the index —
    // the repo's and any nested repo's. No path component may be ".git" (git
    // itself forbids it), compared case-insensitively (.GIT on macOS).
    const gitDirInside = (rel) => rel.split(path.sep).some((seg) => seg.toLowerCase() === '.git');
    const noGit = () => new AppError('Access to .git/ is not allowed', 403);
    if (gitDirInside(path.relative(dir, abs))) throw noGit();

    const root = fs.realpathSync(dir);
    const inside = (p) => p === root || p.startsWith(root + path.sep);
    const real = (p) => { try { return fs.realpathSync(p); } catch { return null; } };
    const exists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

    let probe = path.dirname(abs); // deepest existing ancestor of the parent
    while (!exists(probe)) probe = path.dirname(probe);
    const parentReal = real(probe);
    if (!parentReal || !inside(parentReal)) throw outside();
    // The same rule on the REAL path: `gdir -> .git` makes "gdir/config" .git/config.
    if (gitDirInside(path.relative(root, parentReal))) throw noGit();

    if (follow && exists(abs) && fs.lstatSync(abs).isSymbolicLink()) {
      const target = real(abs);
      if (!target || !inside(target)) throw outside();
      if (gitDirInside(path.relative(root, target))) throw noGit(); // `cfg -> .git/config`
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

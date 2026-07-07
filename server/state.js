import path from 'node:path';
import fs from 'node:fs';

/**
 * Holds the currently opened repository and in-progress merge state.
 * Single-user local app: one open repo at a time.
 */
class RepoState {
  constructor() {
    this.dir = null;
    this.merge = null; // { theirRef, theirOid, files: [], resolved: [] }
  }

  open(dir) {
    const resolved = path.resolve(dir);
    if (!fs.existsSync(path.join(resolved, '.git'))) {
      throw new AppError(`Not a Git repository: ${resolved}`, 400);
    }
    this.dir = resolved;
    this.merge = null;
    return resolved;
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

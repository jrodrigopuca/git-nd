import path from 'node:path';
import chokidar from 'chokidar';
import { broadcast } from './state.js';

/**
 * Watches the open repository so the UI refreshes on external changes
 * (editors, terminal git commands). Two scopes:
 *  - the working tree (ignoring .git and heavy build dirs)
 *  - the bits of .git that reflect state: HEAD, refs, index, packed-refs
 * Events are debounced into a single `fs-changed` broadcast.
 */
const SKIP_DIRS = new Set(['node_modules', '.next', 'dist', 'build', 'coverage', '.venv', '__pycache__']);
const DEBOUNCE_MS = 350;

let watcher = null;
let timer = null;
let pending = 0;

function schedule() {
  pending++;
  clearTimeout(timer);
  timer = setTimeout(() => {
    broadcast('fs-changed', { changes: pending });
    pending = 0;
  }, DEBOUNCE_MS);
}

export async function watchRepo(dir) {
  if (watcher) {
    await watcher.close().catch(() => {});
    watcher = null;
  }
  clearTimeout(timer);
  pending = 0;

  const gitdir = path.join(dir, '.git');
  watcher = chokidar.watch(
    [dir, path.join(gitdir, 'HEAD'), path.join(gitdir, 'refs'), path.join(gitdir, 'index'), path.join(gitdir, 'packed-refs')],
    {
      ignoreInitial: true,
      ignored: (p) => {
        const rel = path.relative(dir, p);
        if (rel.startsWith('..')) return true;
        const parts = rel.split(path.sep);
        // .git internals are covered by the explicit paths above.
        if (parts[0] === '.git' && !['HEAD', 'refs', 'index', 'packed-refs'].includes(parts[1])) return true;
        return parts.some((seg) => SKIP_DIRS.has(seg));
      },
    },
  );
  watcher.on('all', schedule);
  watcher.on('error', () => {}); // e.g. permissions on transient files
}

// Shared test setup. Scenarios are built with the git CLI (test-only: the app
// itself never needs a git binary) in throwaway dirs, and HOME points to a
// temp dir BEFORE the server modules load, so tests never see the user's
// ~/.git-nd settings or tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnd-test-'));
process.env.HOME = path.join(root, 'home');
fs.mkdirSync(process.env.HOME);

export const svc = await import('../server/gitService.js');
export const { repoState } = await import('../server/state.js');

/** Run git in `dir` with a fixed identity; returns trimmed stdout. */
export function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir, encoding: 'utf8',
  }).trim();
}

/** New repo with `files` ({ path: content }) committed on `main`. */
export function makeRepo(name, files = { 'a.txt': 'a1\na2\n' }) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [p, content] of Object.entries(files)) write(dir, p, content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

export function write(dir, p, content) {
  fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
  fs.writeFileSync(path.join(dir, p), content);
}

export const read = (dir, p) => fs.readFileSync(path.join(dir, p), 'utf8');

/** Open `dir` as the app's current repo. */
export function open(dir) {
  repoState.open(dir);
  return dir;
}

export const author = { name: 't', email: 't@t' };

export function cleanup() {
  fs.rmSync(root, { recursive: true, force: true });
}

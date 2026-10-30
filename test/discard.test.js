// BACKLOG B-03: discarding unstaged changes restores the INDEX version, like
// `git restore <file>`, so staged work survives. Each case runs on two
// identical repos: one discarded by the app, one by `git restore`; both must
// end with the same index and working tree.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { svc, git, makeRepo, write, open, cleanup } from './helpers.js';

after(cleanup);

const state = (dir, p) => ({
  index: (() => { try { return git(dir, 'show', `:${p}`); } catch { return null; } })(),
  worktree: fs.existsSync(path.join(dir, p)) ? fs.readFileSync(path.join(dir, p), 'utf8') : null,
  mode: (() => { try { return git(dir, 'ls-files', '-s', p).split(' ')[0] || null; } catch { return null; } })(),
});

/** Build the scenario twice, discard with the app vs `git restore`, compare. */
async function compare(name, setup, file, { gitRestoreFails = false } = {}) {
  const viaApp = makeRepo(`${name}-app`, { 'a.txt': 'a1\na2\n' });
  const viaGit = makeRepo(`${name}-git`, { 'a.txt': 'a1\na2\n' });
  setup(viaApp);
  setup(viaGit);
  open(viaApp);
  await svc.discard(file);
  if (gitRestoreFails) fs.rmSync(path.join(viaGit, file), { force: true }); // untracked: git clean semantics
  else git(viaGit, 'restore', '--', file);
  assert.deepEqual(state(viaApp, file), state(viaGit, file));
  return state(viaApp, file);
}

test('staged + unstaged changes: the staged change survives', async () => {
  const s = await compare('both', (d) => {
    write(d, 'a.txt', 'a1\na2\nSTAGED\n'); git(d, 'add', 'a.txt');
    write(d, 'a.txt', 'a1\na2\nSTAGED\nUNSTAGED\n');
  }, 'a.txt');
  assert.equal(s.worktree, 'a1\na2\nSTAGED\n');
});

test('new staged file with more edits: back to the staged version, still in the index', async () => {
  const s = await compare('newfile', (d) => {
    write(d, 'new.txt', 'NEWWORK\n'); git(d, 'add', 'new.txt');
    write(d, 'new.txt', 'NEWWORK\nMORE\n');
  }, 'new.txt');
  assert.equal(s.worktree, 'NEWWORK\n');
  assert.equal(s.index, 'NEWWORK');
});

test('untracked file is deleted', async () => {
  const s = await compare('untracked', (d) => write(d, 'junk.txt', 'junk\n'), 'junk.txt', { gitRestoreFails: true });
  assert.equal(s.worktree, null);
});

test('only unstaged changes: back to HEAD (index == HEAD)', async () => {
  const s = await compare('plain', (d) => write(d, 'a.txt', 'changed\n'), 'a.txt');
  assert.equal(s.worktree, 'a1\na2\n');
});

test('file deleted from the working tree comes back, with its executable bit', async () => {
  const s = await compare('exec', (d) => {
    write(d, 'run.sh', '#!/bin/sh\necho hi\n'); fs.chmodSync(path.join(d, 'run.sh'), 0o755);
    git(d, 'add', 'run.sh'); git(d, 'commit', '-qm', 'script');
    fs.rmSync(path.join(d, 'run.sh'));
  }, 'run.sh');
  assert.equal(s.worktree, '#!/bin/sh\necho hi\n');
  assert.equal(s.mode, '100755');
});

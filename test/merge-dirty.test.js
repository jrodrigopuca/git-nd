// BACKLOG B-02: merging must never destroy uncommitted work.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { svc, git, makeRepo, write, read, open, author, cleanup } from './helpers.js';

after(cleanup);

/** main + a `feat` branch that changes b.txt (and optionally adds files). */
function repoWithFeature(name, featFiles = { 'b.txt': 'b\nfeat\n' }) {
  const dir = makeRepo(name, { 'a.txt': 'a1\na2\n', 'b.txt': 'b\n' });
  git(dir, 'checkout', '-q', '-b', 'feat');
  for (const [p, c] of Object.entries(featFiles)) write(dir, p, c);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'feat');
  git(dir, 'checkout', '-q', 'main');
  return dir;
}

test('fast-forward merge refuses when a tracked file has local edits, and keeps them', async () => {
  const dir = open(repoWithFeature('ff-dirty'));
  write(dir, 'a.txt', 'a1\na2\nLOCALEDIT\n');
  await assert.rejects(svc.mergeBranch({ theirRef: 'feat', author }), /local changes|uncommitted/i);
  assert.equal(read(dir, 'a.txt'), 'a1\na2\nLOCALEDIT\n');
  assert.equal(git(dir, 'rev-parse', 'HEAD'), git(dir, 'rev-parse', 'main'), 'branch did not move');
  assert.notEqual(git(dir, 'rev-parse', 'main'), git(dir, 'rev-parse', 'feat'));
});

test('merge commit refuses with staged changes too, and keeps them', async () => {
  const dir = repoWithFeature('mc-dirty');
  write(dir, 'a.txt', 'a1\nMAIN\n'); // diverge main so it is a real merge
  git(dir, 'commit', '-qam', 'main change');
  open(dir);
  write(dir, 'a.txt', 'a1\nMAIN\nSTAGED\n');
  git(dir, 'add', 'a.txt');
  await assert.rejects(svc.mergeBranch({ theirRef: 'feat', author }), /local changes|uncommitted/i);
  assert.equal(read(dir, 'a.txt'), 'a1\nMAIN\nSTAGED\n');
  assert.equal(git(dir, 'show', ':a.txt'), 'a1\nMAIN\nSTAGED');
});

test('an untracked file the merge would overwrite is protected', async () => {
  const dir = open(repoWithFeature('untracked-clash', { 'new.txt': 'from feat\n' }));
  write(dir, 'new.txt', 'my untracked work\n');
  await assert.rejects(svc.mergeBranch({ theirRef: 'feat', author }), /untracked|overwrit/i);
  assert.equal(read(dir, 'new.txt'), 'my untracked work\n');
});

test('unrelated untracked files do not block the merge and survive it', async () => {
  const dir = open(repoWithFeature('untracked-ok'));
  write(dir, 'notes.txt', 'scratch\n');
  await svc.mergeBranch({ theirRef: 'feat', author });
  assert.equal(git(dir, 'rev-parse', 'main'), git(dir, 'rev-parse', 'feat'), 'fast-forwarded');
  assert.equal(read(dir, 'notes.txt'), 'scratch\n');
  assert.equal(read(dir, 'b.txt'), 'b\nfeat\n');
});

test('clean tree: merge commit still works', async () => {
  const dir = repoWithFeature('mc-clean');
  write(dir, 'a.txt', 'a1\nMAIN\n');
  git(dir, 'commit', '-qam', 'main change');
  open(dir);
  await svc.mergeBranch({ theirRef: 'feat', author });
  assert.equal(git(dir, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length, 3, 'two parents');
  assert.equal(read(dir, 'b.txt'), 'b\nfeat\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

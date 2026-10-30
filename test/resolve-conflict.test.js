// BACKLOG B-07 (server side): a conflict resolution is only accepted while a
// merge is in progress and for a file that merge left in conflict.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { svc, git, makeRepo, write, read, author, cleanup } from './helpers.js';

after(cleanup);

function conflictRepo(name) {
  const dir = makeRepo(name, { 'f.txt': 'base\n', 'g.txt': 'g\n' });
  git(dir, 'checkout', '-q', '-b', 'feat');
  write(dir, 'f.txt', 'FEAT\n');
  git(dir, 'commit', '-qam', 'feat');
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'f.txt', 'MAIN\n');
  git(dir, 'commit', '-qam', 'main');
  return dir;
}

test('after an abort, saving a resolution is refused and the tree stays clean', async () => {
  const dir = conflictRepo('aborted');
  await svc.openRepo(dir);
  await svc.mergeBranch({ theirRef: 'feat', author });
  await svc.abortMerge();
  await assert.rejects(svc.resolveConflict('f.txt', 'FEAT\n'), /no merge in progress/i);
  assert.equal(read(dir, 'f.txt'), 'MAIN\n');
  assert.equal(git(dir, 'status', '--porcelain'), '');
});

test('a file that is not in conflict cannot be "resolved"', async () => {
  const dir = conflictRepo('notconflicted');
  await svc.openRepo(dir);
  await svc.mergeBranch({ theirRef: 'feat', author });
  await assert.rejects(svc.resolveConflict('g.txt', 'changed\n'), /not in conflict/i);
  assert.equal(read(dir, 'g.txt'), 'g\n');
});

test('content with conflict markers is refused', async () => {
  const dir = conflictRepo('markers');
  await svc.openRepo(dir);
  await svc.mergeBranch({ theirRef: 'feat', author });
  await assert.rejects(svc.resolveConflict('f.txt', '<<<<<<< ours\nMAIN\n=======\nFEAT\n>>>>>>> feat\n'), /markers/i);
});

test('during the merge, a resolution is written, staged and marked resolved', async () => {
  const dir = conflictRepo('ok');
  await svc.openRepo(dir);
  await svc.mergeBranch({ theirRef: 'feat', author });
  await svc.resolveConflict('f.txt', 'BOTH\n');
  assert.equal(read(dir, 'f.txt'), 'BOTH\n');
  assert.equal(git(dir, 'show', ':f.txt'), 'BOTH');
  assert.deepEqual((await svc.repoInfo()).merge.resolved, ['f.txt']);
});

// BACKLOG B-06: a merge in progress lives on disk (.git/MERGE_HEAD + MERGE_MSG,
// git's own format), so it survives reopening the repo / restarting the server,
// and a merge started with the git CLI is picked up too.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { svc, repoState, git, makeRepo, write, read, author, cleanup } from './helpers.js';

after(cleanup);

/** main and feat both change f.txt → conflict. */
function conflictRepo(name) {
  const dir = makeRepo(name, { 'f.txt': 'base\n', 'other.txt': 'o\n' });
  git(dir, 'checkout', '-q', '-b', 'feat');
  write(dir, 'f.txt', 'FEAT\n');
  write(dir, 'other.txt', 'o\nfrom feat\n'); // auto-merged file
  git(dir, 'commit', '-qam', 'feat');
  git(dir, 'checkout', '-q', 'main');
  write(dir, 'f.txt', 'MAIN\n');
  git(dir, 'commit', '-qam', 'main');
  return dir;
}

/** What a server restart does to the in-memory state, then open the repo again. */
async function restartAndOpen(dir) {
  repoState.merge = null;
  repoState.dir = null;
  await svc.openRepo(dir);
}

const mergeFile = (dir, f) => path.join(dir, '.git', f);
const parents = (dir) => git(dir, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length - 1;

test('a conflicted merge writes MERGE_HEAD and MERGE_MSG like git', async () => {
  const dir = conflictRepo('writes');
  await svc.openRepo(dir);
  const r = await svc.mergeBranch({ theirRef: 'feat', author });
  assert.deepEqual(r.conflicts, ['f.txt']);
  assert.equal(fs.readFileSync(mergeFile(dir, 'MERGE_HEAD'), 'utf8').trim(), git(dir, 'rev-parse', 'feat'));
  const msg = fs.readFileSync(mergeFile(dir, 'MERGE_MSG'), 'utf8');
  assert.match(msg, /^Merge feat/);
  assert.match(msg, /# Conflicts:\n#\tf\.txt/);
});

test('restart mid-merge → still a merge; completing gives two parents and no markers', async () => {
  const dir = conflictRepo('survives');
  await svc.openRepo(dir);
  await svc.mergeBranch({ theirRef: 'feat', author });

  await restartAndOpen(dir);
  const info = await svc.repoInfo();
  assert.ok(info.merge, 'merge restored after restart');
  assert.deepEqual(info.merge.files, ['f.txt']);
  assert.deepEqual(info.merge.resolved, []);
  await assert.rejects(svc.commit({ message: 'plain', author }), /unresolved/i, 'plain commit refused');

  write(dir, 'f.txt', 'RESOLVED\n');
  await svc.stage('f.txt');
  await restartAndOpen(dir); // resolution survives a restart too
  assert.deepEqual((await svc.repoInfo()).merge.resolved, ['f.txt']);

  await svc.commit({ message: '', author });
  assert.equal(parents(dir), 2);
  assert.equal(git(dir, 'rev-parse', 'HEAD^2'), git(dir, 'rev-parse', 'feat'));
  assert.equal(read(dir, 'f.txt'), 'RESOLVED\n');
  assert.equal(read(dir, 'other.txt'), 'o\nfrom feat\n');
  assert.ok(!fs.existsSync(mergeFile(dir, 'MERGE_HEAD')), 'MERGE_HEAD removed');
  assert.ok(!fs.existsSync(mergeFile(dir, 'MERGE_MSG')), 'MERGE_MSG removed');
  await restartAndOpen(dir);
  assert.equal((await svc.repoInfo()).merge, null);
});

test('a staged file that still has conflict markers is not counted as resolved', async () => {
  const dir = conflictRepo('markers');
  await svc.openRepo(dir);
  await svc.mergeBranch({ theirRef: 'feat', author });
  write(dir, 'f.txt', '<<<<<<< ours\nMAIN\n=======\nFEAT\n>>>>>>> feat\n');
  git(dir, 'add', 'f.txt'); // staged outside the app, markers included
  await restartAndOpen(dir);
  assert.deepEqual((await svc.repoInfo()).merge.resolved, []);
});

test('abort after a restart cleans the merge files and the tree', async () => {
  const dir = conflictRepo('abort');
  await svc.openRepo(dir);
  await svc.mergeBranch({ theirRef: 'feat', author });
  await restartAndOpen(dir);
  await svc.abortMerge();
  assert.ok(!fs.existsSync(mergeFile(dir, 'MERGE_HEAD')));
  assert.ok(!fs.existsSync(mergeFile(dir, 'MERGE_MSG')));
  assert.equal(read(dir, 'f.txt'), 'MAIN\n');
  assert.equal(parents(dir), 1);
  assert.equal((await svc.repoInfo()).merge, null);
});

test('a merge started with the git CLI is shown as in progress and completes as a merge', async () => {
  const dir = conflictRepo('cli');
  assert.throws(() => git(dir, 'merge', 'feat'), 'CLI merge stops on the conflict');
  await svc.openRepo(dir);
  const info = await svc.repoInfo();
  assert.ok(info.merge, 'CLI merge detected');
  assert.deepEqual(info.merge.files, ['f.txt']);
  await assert.rejects(svc.commit({ message: 'plain', author }), /unresolved/i);

  write(dir, 'f.txt', 'RESOLVED\n');
  await svc.stage('f.txt');
  await svc.commit({ message: '', author });
  assert.equal(parents(dir), 2);
  assert.equal(git(dir, 'status', '--porcelain'), '');
  assert.ok(!fs.existsSync(mergeFile(dir, 'MERGE_HEAD')));
});

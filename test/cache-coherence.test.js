// BACKLOG B-19: the app's own index writes must be visible to its next read.
// isomorphic-git detects a changed index by mtime (seconds), inode and size,
// so a same-size write within the same second went unnoticed by the shared
// cache when the write itself bypassed that cache. These sequences run with
// no waits on purpose: same second, same file size.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { svc, git, makeRepo, write, read, author, cleanup } from './helpers.js';

after(cleanup);

const status = async () => (await svc.status()).files.map((f) => `${f.filepath}:${f.stageStatus || '-'}/${f.workStatus || '-'}`);

test('stage → status → unstage → commit is refused (no empty commit)', async () => {
  const dir = makeRepo('empty-commit', { 'b.txt': 'bbbb\n' });
  await svc.openRepo(dir);
  write(dir, 'b.txt', 'BBBB\n');
  await svc.stage('b.txt');
  await status();
  await svc.unstage('b.txt');
  const head = git(dir, 'rev-parse', 'HEAD');
  await assert.rejects(svc.commit({ message: 'should be refused', author }), /nothing staged/i);
  assert.equal(git(dir, 'rev-parse', 'HEAD'), head, 'no commit was created');
});

test('discard after re-staging restores the staged version', async () => {
  const dir = makeRepo('discard-restage', { 'b.txt': 'bbbb\n' });
  await svc.openRepo(dir);
  write(dir, 'b.txt', 'BBBB\n');
  await svc.stage('b.txt');
  await status();
  await svc.unstage('b.txt');
  write(dir, 'b.txt', 'XXXX\n');
  await status();
  await svc.stage('b.txt');
  write(dir, 'b.txt', 'YYYY\n');
  await svc.discard('b.txt');
  assert.equal(git(dir, 'show', ':b.txt'), 'XXXX');
  assert.equal(read(dir, 'b.txt'), 'XXXX\n');
});

test('status reflects every same-second stage/unstage flip', async () => {
  const dir = makeRepo('flips', { 'c.txt': 'cccc\n' });
  await svc.openRepo(dir);
  write(dir, 'c.txt', 'CCCC\n');
  for (let i = 0; i < 4; i++) {
    await svc.stage('c.txt');
    assert.deepEqual(await status(), ['c.txt:modified/-'], `after stage #${i}`);
    await svc.unstage('c.txt');
    assert.deepEqual(await status(), ['c.txt:-/modified'], `after unstage #${i}`);
  }
});

test('hunk stage then whole-file unstage then commit is refused', async () => {
  const dir = makeRepo('hunk-then-unstage', { 'd.txt': 'dddd\n' });
  await svc.openRepo(dir);
  write(dir, 'd.txt', 'DDDD\n');
  await svc.applyHunkOp('d.txt', [0], 'stage');
  await status();
  await svc.unstage('d.txt');
  await assert.rejects(svc.commit({ message: 'x', author }), /nothing staged/i);
});

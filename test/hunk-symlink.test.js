// BACKLOG B-20: hunk operations must not follow symlinks. Git versions the
// link (its target path), so a link is staged or discarded as a whole.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { svc, git, makeRepo, write, cleanup } from './helpers.js';

after(cleanup);

function linkRepo(name) {
  const dir = makeRepo(name, { 'a.txt': 'a\n' });
  fs.symlinkSync('a.txt', path.join(dir, 'l.txt'));
  git(dir, 'add', 'l.txt');
  git(dir, 'commit', '-qm', 'link');
  return dir;
}

test('an unmodified symlink offers no hunks, even when its target changed', async () => {
  const dir = linkRepo('unmodified');
  write(dir, 'a.txt', 'a\nchanged\n'); // the target changes; the link itself does not
  await svc.openRepo(dir);
  const view = await svc.fileHunks('l.txt', 'unstaged');
  assert.deepEqual(view.hunks, []);
  assert.equal(view.symlink, true);
});

test('hunk operations on a symlink are refused and the link blob is untouched', async () => {
  const dir = linkRepo('refused');
  write(dir, 'a.txt', 'a\nchanged\n');
  await svc.openRepo(dir);
  for (const op of ['stage', 'unstage', 'discard']) {
    await assert.rejects(svc.applyHunkOp('l.txt', [0], op), /symbolic link|symlink/i, op);
  }
  assert.equal(git(dir, 'ls-files', '-s', 'l.txt').split(' ')[0], '120000');
  assert.equal(git(dir, 'show', ':l.txt'), 'a.txt', 'the index still holds the link target');
  assert.equal(fs.readlinkSync(path.join(dir, 'l.txt')), 'a.txt');
});

test('whole-entry stage of a re-pointed link still works', async () => {
  const dir = linkRepo('repoint');
  write(dir, 'b.txt', 'b\n');
  fs.rmSync(path.join(dir, 'l.txt'));
  fs.symlinkSync('b.txt', path.join(dir, 'l.txt'));
  await svc.openRepo(dir);
  await svc.stage('l.txt');
  assert.equal(git(dir, 'show', ':l.txt'), 'b.txt');
  assert.equal(git(dir, 'ls-files', '-s', 'l.txt').split(' ')[0], '120000');
});

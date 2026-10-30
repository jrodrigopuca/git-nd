// BACKLOG B-11: hunk operations keep the file mode (an executable stays 100755).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { svc, git, makeRepo, write, cleanup } from './helpers.js';

after(cleanup);

const modeOf = (dir, p) => git(dir, 'ls-files', '-s', p).split(' ')[0];

test('staging and unstaging a hunk of an executable keeps 100755', async () => {
  const dir = makeRepo('exec', { 'run.sh': '#!/bin/sh\necho one\n' });
  fs.chmodSync(path.join(dir, 'run.sh'), 0o755);
  git(dir, 'add', 'run.sh');
  git(dir, 'commit', '-qm', 'exec');
  assert.equal(modeOf(dir, 'run.sh'), '100755');

  write(dir, 'run.sh', '#!/bin/sh\necho one\necho two\n');
  await svc.openRepo(dir);
  await svc.applyHunkOp('run.sh', [0], 'stage');
  assert.equal(modeOf(dir, 'run.sh'), '100755', 'after stage');
  assert.doesNotMatch(git(dir, 'diff', '--cached', '--summary'), /mode change/);

  await svc.applyHunkOp('run.sh', [0], 'unstage');
  assert.equal(modeOf(dir, 'run.sh'), '100755', 'after unstage');
});

test('a new executable file staged by hunk enters the index as 100755', async () => {
  const dir = makeRepo('newexec');
  write(dir, 'tool.sh', '#!/bin/sh\necho hi\n');
  fs.chmodSync(path.join(dir, 'tool.sh'), 0o755);
  await svc.openRepo(dir);
  await svc.applyHunkOp('tool.sh', [0], 'stage');
  assert.equal(modeOf(dir, 'tool.sh'), '100755');
});

test('a regular file stays 100644 (regression)', async () => {
  const dir = makeRepo('regular', { 'a.txt': 'a\n' });
  write(dir, 'a.txt', 'a\nb\n');
  await svc.openRepo(dir);
  await svc.applyHunkOp('a.txt', [0], 'stage');
  assert.equal(modeOf(dir, 'a.txt'), '100644');
});

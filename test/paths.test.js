// BACKLOG B-09 (symlinks must not escape the repo) and B-13 (.git/ is off
// limits for the file API).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { svc, git, makeRepo, write, read, cleanup } from './helpers.js';

after(cleanup);

const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnd-outside-'));
after(() => fs.rmSync(outside, { recursive: true, force: true }));
fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret-outside\n');

/** Repo with links committed the way a malicious clone would bring them. */
function linkedRepo(name) {
  const dir = makeRepo(name, { 'a.txt': 'a\n', 'inner/real.txt': 'real\n' });
  fs.symlinkSync(outside, path.join(dir, 'outdir'));                       // dir link → outside
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'outfile')); // file link → outside
  fs.symlinkSync(path.join(outside, 'nope.txt'), path.join(dir, 'dangling')); // dangling → outside
  fs.symlinkSync('inner/real.txt', path.join(dir, 'inlink'));              // link → inside
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'links');
  return dir;
}

const forbidden = /outside the open repository|not allowed|forbidden/i;

test('reading through a symlink that leaves the repo is refused', async () => {
  await svc.openRepo(linkedRepo('read'));
  await assert.rejects(svc.readFile('outdir/secret.txt'), forbidden);
  await assert.rejects(svc.readFile('outfile'), forbidden);
  await assert.rejects(svc.tree('outdir'), forbidden);
});

test('writing through a symlink that leaves the repo is refused, nothing lands outside', async () => {
  await svc.openRepo(linkedRepo('write'));
  await assert.rejects(svc.writeFile('outdir/pwned.txt', 'x'), forbidden);
  await assert.rejects(svc.writeFile('outdir/sub/new.txt', 'x'), forbidden, 'new file under a linked dir');
  await assert.rejects(svc.writeFile('outfile', 'x'), forbidden);
  await assert.rejects(svc.writeFile('dangling', 'x'), forbidden, 'dangling link would create the target');
  assert.ok(!fs.existsSync(path.join(outside, 'pwned.txt')));
  assert.ok(!fs.existsSync(path.join(outside, 'sub')));
  assert.ok(!fs.existsSync(path.join(outside, 'nope.txt')));
  assert.equal(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8'), 'secret-outside\n');
});

test('hunks and staging cannot reach through a linked directory', async () => {
  await svc.openRepo(linkedRepo('hunks'));
  await assert.rejects(svc.fileHunks('outdir/secret.txt', 'unstaged'), forbidden);
  await assert.rejects(svc.stage('outdir/secret.txt'), forbidden);
});

test('a symlink pointing inside the repo still works', async () => {
  const dir = linkedRepo('inside');
  await svc.openRepo(dir);
  assert.equal((await svc.readFile('inlink')).content, 'real\n');
  await svc.writeFile('inlink', 'edited\n');
  assert.equal(read(dir, 'inner/real.txt'), 'edited\n');
});

test('the links themselves can still be staged and discarded (git tracks links, not targets)', async () => {
  const dir = linkedRepo('linkops');
  await svc.openRepo(dir);
  fs.rmSync(path.join(dir, 'outfile'));
  await svc.discard('outfile'); // restores the LINK from the index
  assert.equal(fs.readlinkSync(path.join(dir, 'outfile')), path.join(outside, 'secret.txt'));
  fs.rmSync(path.join(dir, 'outdir'));
  await svc.stage('outdir'); // stages the deletion of the link
  assert.match(git(dir, 'status', '--porcelain'), /^D  outdir$/m);
});

test('symlinks INTO .git (file or dir) and nested repos\' .git are refused too', async () => {
  const dir = makeRepo('gitlinks');
  const config = read(dir, '.git/config');
  fs.symlinkSync('.git/config', path.join(dir, 'cfg'));
  fs.symlinkSync('.git', path.join(dir, 'gdir'));
  fs.mkdirSync(path.join(dir, 'nested'));
  git(path.join(dir, 'nested'), 'init', '-q');
  await svc.openRepo(dir);
  await assert.rejects(svc.readFile('cfg'), forbidden);
  await assert.rejects(svc.writeFile('cfg', 'x'), forbidden);
  await assert.rejects(svc.readFile('gdir/config'), forbidden);
  await assert.rejects(svc.writeFile('gdir/hooks/pre-commit', '#!/bin/sh\n'), forbidden);
  await assert.rejects(svc.tree('gdir'), forbidden);
  // Hunks never follow a link (B-20): no .git/config content is shown or written.
  assert.deepEqual((await svc.fileHunks('cfg', 'unstaged')).hunks, []);
  await assert.rejects(svc.applyHunkOp('cfg', [0], 'discard'));
  await assert.rejects(svc.readFile('nested/.git/config'), forbidden);
  await assert.rejects(svc.writeFile('nested/.git/hooks/pre-commit', 'x'), forbidden);
  assert.equal(read(dir, '.git/config'), config, '.git/config untouched');
  assert.ok(!fs.existsSync(path.join(dir, '.git/hooks/pre-commit')));
});

test('.git/ cannot be read or written through the file API (any case)', async () => {
  const dir = makeRepo('gitdir');
  await svc.openRepo(dir);
  const before = read(dir, '.git/config');
  await assert.rejects(svc.readFile('.git/config'), forbidden);
  await assert.rejects(svc.writeFile('.git/config', '[remote "origin"]\n\turl = http://evil\n'), forbidden);
  await assert.rejects(svc.writeFile('.GIT/config', 'x'), forbidden, 'case-insensitive filesystems');
  await assert.rejects(svc.writeFile('sub/../.git/hooks/x', 'x'), forbidden);
  await assert.rejects(svc.tree('.git'), forbidden);
  assert.equal(read(dir, '.git/config'), before);
  write(dir, '.gitignore', 'node_modules\n'); // a file merely starting with ".git" is fine
  assert.equal((await svc.readFile('.gitignore')).content, 'node_modules\n');
});

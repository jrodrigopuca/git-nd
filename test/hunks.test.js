// BACKLOG B-05: hunk stage/unstage/discard must be byte-exact, with or without
// a final newline. Applying ALL hunks must equal the whole-file git command:
// stage ≡ `git add`, discard ≡ `git restore`, unstage ≡ `git restore --staged`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { svc, git, makeRepo, write, open, cleanup } from './helpers.js';

after(cleanup);

const indexOf = (dir, p) => execBuf(dir, ['show', `:${p}`]);
const execBuf = (dir, args) => {
  // git() trims output; the final newline is exactly what we test, so read raw bytes.
  const { execFileSync } = process.getBuiltinModule('node:child_process');
  return execFileSync('git', args, { cwd: dir }).toString('utf8');
};
const disk = (dir, p) => fs.readFileSync(path.join(dir, p), 'utf8');

const CASES = {
  'append a line to a file without final newline': ['x1\nx2\nx3', 'x1\nx2\nx3\nx4'],
  'remove the final newline': ['x1\nx2\nx3\n', 'x1\nx2\nx3'],
  'add a final newline': ['x1\nx2\nx3', 'x1\nx2\nx3\n'],
  'edit the last line, no final newline on either side': ['a\nb\nc', 'a\nb\nC'],
  'normal file (regression)': ['l1\nl2\nl3\nl4\nl5\n', 'l1\nL2\nl3\nl4\nl5\nl6\n'],
  'two distant hunks (regression)': [
    Array.from({ length: 20 }, (_, i) => `r${i}`).join('\n') + '\n',
    Array.from({ length: 20 }, (_, i) => (i === 1 ? 'R1' : i === 18 ? 'R18' : `r${i}`)).join('\n') + '\n',
  ],
};

async function allHunks(file, target) {
  return (await svc.fileHunks(file, target)).hunks.map((h) => h.index);
}

for (const [name, [before, afterText]] of Object.entries(CASES)) {
  const slug = name.replace(/\W+/g, '-');

  test(`stage all hunks ≡ git add — ${name}`, async () => {
    const appRepo = makeRepo(`st-${slug}-app`, { 'f.txt': before });
    const gitRepo = makeRepo(`st-${slug}-git`, { 'f.txt': before });
    for (const d of [appRepo, gitRepo]) write(d, 'f.txt', afterText);
    open(appRepo);
    await svc.applyHunkOp('f.txt', await allHunks('f.txt', 'unstaged'), 'stage');
    git(gitRepo, 'add', 'f.txt');
    assert.equal(indexOf(appRepo, 'f.txt'), indexOf(gitRepo, 'f.txt'));
    assert.equal(indexOf(appRepo, 'f.txt'), afterText);
    assert.equal(disk(appRepo, 'f.txt'), afterText, 'working tree untouched');
  });

  test(`discard all hunks ≡ git restore — ${name}`, async () => {
    const dir = makeRepo(`dc-${slug}`, { 'f.txt': before });
    write(dir, 'f.txt', afterText);
    open(dir);
    await svc.applyHunkOp('f.txt', await allHunks('f.txt', 'unstaged'), 'discard');
    assert.equal(disk(dir, 'f.txt'), before);
  });

  test(`unstage all hunks ≡ git restore --staged — ${name}`, async () => {
    const dir = makeRepo(`us-${slug}`, { 'f.txt': before });
    write(dir, 'f.txt', afterText);
    git(dir, 'add', 'f.txt');
    open(dir);
    await svc.applyHunkOp('f.txt', await allHunks('f.txt', 'staged'), 'unstage');
    assert.equal(indexOf(dir, 'f.txt'), before);
    assert.equal(disk(dir, 'f.txt'), afterText, 'working tree untouched');
  });
}

test('partial: staging only the first of two hunks', async () => {
  const [before, afterText] = CASES['two distant hunks (regression)'];
  const dir = makeRepo('partial', { 'f.txt': before });
  write(dir, 'f.txt', afterText);
  open(dir);
  const { hunks } = await svc.fileHunks('f.txt', 'unstaged');
  assert.equal(hunks.length, 2);
  await svc.applyHunkOp('f.txt', [0], 'stage');
  assert.equal(indexOf(dir, 'f.txt'), before.replace('r1\n', 'R1\n'));
});

test('the hunk view does not show the "No newline" marker as a file line', async () => {
  const dir = makeRepo('view', { 'f.txt': 'x1\nx2\nx3' });
  write(dir, 'f.txt', 'x1\nx2\nx3\nx4');
  open(dir);
  const { hunks } = await svc.fileHunks('f.txt', 'unstaged');
  const texts = hunks.flatMap((h) => h.rows.flatMap((r) => [r.left?.text, r.right?.text])).filter((t) => t !== undefined);
  assert.ok(!texts.some((t) => /No newline at end of file/.test(t)), JSON.stringify(texts));
});

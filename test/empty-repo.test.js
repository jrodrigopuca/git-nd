// BACKLOG B-08: a repo without commits is a valid state, not an error.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { svc, git, write, author, cleanup } from './helpers.js';

after(cleanup);

test('empty repo: every refresh endpoint answers; the first commit then shows up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnd-empty-'));
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'new.txt', 'hello\n');
  await svc.openRepo(dir);

  assert.deepEqual(await svc.history({ depth: 80 }), []);
  assert.equal((await svc.repoInfo()).branch, 'main');
  assert.deepEqual((await svc.status()).files.map((f) => f.filepath), ['new.txt']);
  assert.deepEqual((await svc.graphPage({ limit: 200 })).commits, []);
  assert.deepEqual((await svc.tree('.')).map((e) => e.name), ['new.txt']);

  await svc.stage('new.txt');
  await svc.commit({ message: 'first', author });
  const h = await svc.history({ depth: 80 });
  assert.equal(h.length, 1);
  assert.equal(h[0].message, 'first');
  assert.equal((await svc.graphPage({ limit: 200 })).commits.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

// BACKLOG B-08 / B-21: an empty repo is a valid repo, and a panel that fails
// to load shows empty — never the previous repo's data.
import { test, expect, git, write, identity } from './fixtures.js';
import fs from 'node:fs';
import path from 'node:path';

const fail500 = (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"forced by the test"}' });
const isApi = (p) => (url) => url.pathname === p;

test('B-08: an empty repo shows up, and its first commit works', async ({ app, repos, page }) => {
  const A = repos.make('A', { 'README.md': 'a\n' });
  write(A, 'README.md', 'a\nA-DIRTY\n');
  const E = path.join(repos.root, 'Empty');
  fs.mkdirSync(E);
  git(E, 'init', '-q', '-b', 'main');
  identity(E);
  write(E, 'new.txt', 'hello\n');

  await app.boot(A, [E]);
  await app.switchTo(E);
  await expect(app.changed('new.txt')).toBeVisible();
  await expect(app.changed('README.md')).toHaveCount(0);
  await expect(page.locator('#graph-wrap')).toContainText('No commits');

  await app.rowAction('unstaged-list', 'new.txt', 'Stage');
  await expect(page.locator('#staged-list')).toContainText('new.txt');
  await page.locator('#commit-msg').fill('first commit');
  await app.saveShortcut();
  await expect(page.locator('#graph-wrap .graph-row')).toHaveCount(1);
  expect(git(E, 'rev-list', '--count', 'HEAD')).toBe('1');
});

test('B-08: if one panel fails, the others update and nothing of the previous repo stays', async ({ app, repos, page }) => {
  const A = repos.make('A', { 'README.md': 'a\n' });
  write(A, 'README.md', 'a\nA-DIRTY\n');
  git(A, 'branch', 'only-in-a');
  const B = repos.make('B', { 'b.txt': 'b\n' });

  await app.boot(A, [B]);
  await expect(app.changed('README.md')).toBeVisible();
  await page.route(isApi('/api/repo/status'), fail500); // the changes panel fails in B
  await app.switchTo(B);
  await expect(app.changed('README.md')).toHaveCount(0); // not A's changes
  await expect(page.locator('#branch-list')).not.toContainText('only-in-a');
  await expect(page.locator('#tree')).toContainText('b.txt');
});

test('B-21: if sync or stash fail, their badges/list are cleared, not left from the previous repo', async ({ app, repos, page }) => {
  const A = repos.make('A', { 'a.txt': 'a\n' });
  for (const n of [1, 2]) { write(A, 'a.txt', `a${n}\n`); git(A, 'commit', '-qam', `c${n}`); }
  git(A, 'remote', 'add', 'origin', 'http://127.0.0.1:9/never.git');
  git(A, 'update-ref', 'refs/remotes/origin/main', 'HEAD~2'); // A is 2 ahead
  write(A, 'a.txt', 'wip\n');
  git(A, 'stash', '-q');
  const B = repos.make('B', { 'b.txt': 'b\n' });

  await app.boot(A, [B]);
  await expect(page.locator('#ahead-badge')).toHaveText('2');
  await expect(page.locator('#stash-list li')).toHaveCount(1);

  await page.route(isApi('/api/repo/sync'), fail500);
  await page.route(isApi('/api/repo/stash'), fail500);
  await app.switchTo(B);
  await expect(page.locator('#ahead-badge')).toBeHidden();
  await expect(page.locator('#stash-list li')).toHaveCount(0);
});

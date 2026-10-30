// Visual review V-B: the commit panel (GitHub Desktop pattern). Message first,
// author as a line, and a button that says what it will do — or why it can't.
import { test, expect, git, write } from './fixtures.js';
import fs from 'node:fs';
import path from 'node:path';

const button = (page) => page.locator('#btn-commit');
const reason = (page) => page.locator('#commit-reason');

test('V-B: message first; the author is a line, editable through "change"', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'a.txt': 'a\n' });
  write(R, 'a.txt', 'a\nb\n');
  await app.boot(R);

  const msg = await page.locator('#commit-msg').boundingBox();
  const authorLine = await page.locator('#author-line').boundingBox();
  expect(msg.y, 'message comes before the author').toBeLessThan(authorLine.y);
  await expect(page.locator('#author-line')).toContainText('E2E User <e2e@example.invalid>');
  await expect(page.locator('#commit-author')).toBeHidden();

  const change = page.locator('#btn-author-change');
  await expect(change).toHaveAttribute('aria-expanded', 'false');
  await change.click();
  await expect(change).toHaveAttribute('aria-expanded', 'true');
  await page.locator('#commit-author').fill('Someone Else <else@example.invalid>');
  await expect(page.locator('#author-line')).toContainText('Someone Else');

  await app.rowAction('unstaged-list', 'a.txt', 'Stage');
  await page.locator('#commit-msg').fill('by someone else');
  await button(page).click();
  await expect.poll(() => git(R, 'log', '-1', '--format=%an <%ae>')).toBe('Someone Else <else@example.invalid>');
});

test('V-B: the button says what it will commit — or is disabled with the reason', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'a.txt': 'a\n', 'b.txt': 'b\n' });
  write(R, 'a.txt', 'a\n1\n');
  write(R, 'b.txt', 'b\n2\n');
  await app.boot(R);

  // Nothing staged: disabled, the reason is visible and linked; an empty hint says what to do.
  await expect(button(page)).toBeDisabled();
  await expect(button(page)).toHaveAttribute('aria-describedby', 'commit-reason');
  await expect(reason(page)).toHaveText(/stage at least one file/i);
  await expect(page.locator('#staged-empty')).toBeVisible();
  const before = git(R, 'rev-list', '--count', 'HEAD');
  await page.locator('#commit-msg').fill('nothing to commit');
  await app.saveShortcut(); // Ctrl+S obeys the same rule
  await page.waitForTimeout(600);
  expect(git(R, 'rev-list', '--count', 'HEAD')).toBe(before);

  await app.rowAction('unstaged-list', 'a.txt', 'Stage');
  await expect(button(page)).toHaveText(/Commit 1 file to main/);
  await expect(button(page)).toBeEnabled();
  await expect(reason(page)).toHaveText('');
  await expect(page.locator('#staged-empty')).toBeHidden();

  await page.getByRole('button', { name: 'Stage all', exact: true }).click(); // text, not "⊕ all"
  await expect(button(page)).toHaveText(/Commit 2 files to main/);
  await expect(page.locator('#staged-count')).toHaveText('2');

  await page.getByRole('button', { name: 'Unstage all', exact: true }).click();
  await expect(button(page)).toBeDisabled();
});

test('V-B: amend is allowed with nothing staged, and says so', async ({ app, repos, page }) => {
  await app.boot(repos.make('R'));
  await expect(button(page)).toBeDisabled();
  await page.locator('#amend-check').check();
  await expect(button(page)).toBeEnabled();
  await expect(button(page)).toHaveText(/Amend last commit/);
});

test('V-B: during a merge the button completes it, and says why it cannot yet', async ({ app, repos, server, page }) => {
  const M = repos.conflict('M');
  await app.boot(M);
  await server.api('/api/repo/merge', { theirRef: 'feat', author: { name: 't', email: 't@t' } });
  await expect(button(page)).toHaveText(/Complete merge/);
  await expect(button(page)).toBeDisabled();
  await expect(reason(page)).toHaveText(/resolve 1 conflicted file/i);

  await server.api('/api/repo/conflict/resolve', { path: 'f.txt', content: 'BOTH\n' });
  await expect(button(page)).toBeEnabled();
  await button(page).click();
  await expect.poll(() => git(M, 'rev-list', '--parents', '-n1', 'HEAD').split(' ').length).toBe(3);
});

test('V-B: with no author configured anywhere, the author field is shown right away', async ({ app, repos, page, server }) => {
  // "Anywhere" includes the app default, which the shared test server saved when
  // earlier tests committed (~/.git-nd/settings.json, re-read on each request).
  fs.rmSync(path.join(server.home, '.git-nd', 'settings.json'), { force: true });
  const dir = path.join(repos.root, 'anon');
  fs.mkdirSync(dir);
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, 'x.txt', 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'init'); // the helper's -c identity is not saved in the repo config
  await app.boot(dir);
  await expect(page.locator('#commit-author')).toBeVisible();
  await expect(page.locator('#author-line')).toContainText(/no author/i);
});

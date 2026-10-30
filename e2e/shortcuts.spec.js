// BACKLOG B-10: keyboard shortcuts act on what is in front of the user — never
// behind a modal, and never committing from an editor tab.
import { test, expect, git, write } from './fixtures.js';

const commits = (dir) => Number(git(dir, 'rev-list', '--count', 'HEAD'));

test('B-10: Ctrl+S commits on the graph, but not behind a modal nor on a binary file', async ({ app, repos, page }) => {
  const C = repos.make('C', { 'a.txt': 'a\n', 'img.bin': Buffer.from([0, 1, 2, 0, 3]) });
  write(C, 'a.txt', 'a\nstaged\n');
  git(C, 'add', 'a.txt');
  await app.boot(C);
  await page.locator('#commit-msg').fill('should only happen once');
  const before = commits(C);

  await page.locator('#btn-clone').click();
  await expect(page.locator('#modal-backdrop')).toBeVisible();
  await app.saveShortcut();
  await page.waitForTimeout(800);
  expect(commits(C), 'no commit behind the modal').toBe(before);
  await page.locator('#modal-backdrop button', { hasText: 'Cancel' }).click();

  await page.locator('#tree .tree-row', { hasText: 'img.bin' }).click();
  await expect(app.tab('file')).toHaveClass(/active/);
  await app.saveShortcut();
  await page.waitForTimeout(800);
  expect(commits(C), 'no commit from the File tab').toBe(before);

  await app.tab('graph').click();
  await app.saveShortcut();
  await expect.poll(() => commits(C)).toBe(before + 1);
});

test('B-10: Ctrl+S on the Conflict tab saves the resolution (and does not commit)', async ({ app, repos, page, server }) => {
  const M = repos.conflict('M');
  await app.boot(M);
  await server.api('/api/repo/merge', { theirRef: 'feat', author: { name: 't', email: 't@t' } });
  await app.openConflict('f.txt');
  await page.locator('#c-text').click();
  await page.locator('#conflict-editor').fill('RESOLVED\n');
  await app.saveShortcut();
  await expect.poll(() => { try { return git(M, 'show', ':f.txt'); } catch { return null; } }).toBe('RESOLVED');
  expect(commits(M)).toBe(2);
});

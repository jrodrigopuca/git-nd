// File and Diff tabs: closing them, and the editor noticing changes made
// outside git-nd (reload when clean, warn + confirm before overwriting).
import { test, expect, git, write, read } from './fixtures.js';
import fs from 'node:fs';
import path from 'node:path';

test('Diff tab: opens from a commit, closes back to the graph, reappears on the next diff', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'a.txt': 'a\n' });
  await app.boot(R);
  const openFirstCommitDiff = async () => {
    await page.locator('#graph-wrap .graph-row').first().click();
    await page.locator('#modal-backdrop .file-list li').first().click();
    await expect(app.tab('diff')).toHaveClass(/active/);
  };
  await openFirstCommitDiff();
  await page.locator('#btn-close-diff').click();
  await expect(app.tab('diff')).toBeHidden();
  await expect(app.tab('graph')).toHaveClass(/active/);
  await expect(page.locator('#diff-view')).toBeEmpty();
  await openFirstCommitDiff();
  await expect(page.locator('#diff-view')).not.toBeEmpty();
});

test('File tab: external edits reload a clean editor, warn on a dirty one, and Save asks before overwriting', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'probe.txt': 'v1 original\n' });
  await app.boot(R);
  const editor = page.locator('#file-editor');
  const status = page.locator('#file-dirty');
  await page.locator('#tree .tree-row', { hasText: 'probe.txt' }).click();
  await expect(editor).toHaveValue('v1 original\n');

  write(R, 'probe.txt', 'v2 external\n'); // clean editor → reload
  await expect(editor).toHaveValue('v2 external\n');
  await expect(page.locator('.toast', { hasText: 'changed on disk' })).toBeVisible();
  await expect(status).toHaveText('');

  await editor.fill('v3 mine\n');           // dirty editor → keep edits, warn
  write(R, 'probe.txt', 'v4 external again\n');
  await expect(status).toContainText('changed on disk');
  await expect(editor).toHaveValue('v3 mine\n');

  await app.saveShortcut();                 // Save → confirm; Cancel leaves disk alone
  await expect(page.locator('#modal-backdrop h2')).toHaveText('File changed on disk');
  await page.locator('#modal-backdrop button', { hasText: 'Cancel' }).click();
  expect(read(R, 'probe.txt')).toBe('v4 external again\n');

  await app.saveShortcut();                 // Confirm writes mine
  await page.locator('#modal-backdrop button', { hasText: 'Confirm' }).click();
  await expect.poll(() => read(R, 'probe.txt')).toBe('v3 mine\n');
  await expect(status).toHaveText('');

  await page.waitForTimeout(1200);          // our own save's watcher echo must not prompt or reload
  await editor.fill('v5 normal save\n');
  await app.saveShortcut();
  await expect.poll(() => read(R, 'probe.txt')).toBe('v5 normal save\n');
  await expect(page.locator('#modal-backdrop')).toBeHidden();

  await page.locator('#btn-close-file').click(); // closed stays closed
  write(R, 'probe.txt', 'v6 after close\n');
  await page.waitForTimeout(1500);
  await expect(app.tab('file')).toBeHidden();
  expect(git(R, 'status', '--porcelain')).toContain('probe.txt');
});

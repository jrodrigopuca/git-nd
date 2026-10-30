// BACKLOG B-04 / B-07: views bound to one repo (Diff, Conflict) must never act
// on another — whoever switches the repo, and however a merge ends.
import { test, expect, git, write, read } from './fixtures.js';

test.describe('switching repositories', () => {
  test('B-04: switching from this tab closes Diff; the other repo keeps its change', async ({ app, repos, page }) => {
    const A = repos.make('A', { 'README.md': 'a1\na2\na3\n' });
    write(A, 'README.md', 'a1\nA-CHANGED\na3\n');
    const B = repos.make('B', { 'README.md': 'b1\nb2\nb3\n' });
    write(B, 'README.md', 'b1\nB-CHANGED-MUST-SURVIVE\nb3\n');

    await app.boot(A, [B]);
    await app.changed('README.md').click();
    await expect(app.tab('diff')).toBeVisible();
    await expect(page.locator('#diff-view button', { hasText: 'Discard' })).toBeVisible();

    await app.switchTo(B);
    await expect(app.tab('diff')).toBeHidden();
    await expect(page.locator('#diff-view button')).toHaveCount(0);
    expect(read(B, 'README.md')).toBe('b1\nB-CHANGED-MUST-SURVIVE\nb3\n');
  });

  test('B-04: another client switching the repo also closes the stale Diff', async ({ app, repos, server, page }) => {
    const A = repos.make('A', { 'README.md': 'a1\na2\n' });
    write(A, 'README.md', 'a1\nA-CHANGED\n');
    const B = repos.make('B', { 'README.md': 'b1\nb2\n' });
    write(B, 'README.md', 'b1\nB-CHANGED-MUST-SURVIVE\n');

    await app.boot(A);
    await app.changed('README.md').click();
    await expect(page.locator('#diff-view button', { hasText: 'Discard' })).toBeVisible();

    await server.api('/api/repo/open', { dir: B }); // another tab / a script
    await expect(page.locator('#repo-name')).toHaveAttribute('title', new RegExp(`^${B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await expect(app.tab('diff')).toBeHidden();
    await expect(page.locator('#diff-view button')).toHaveCount(0);
    expect(read(B, 'README.md')).toBe('b1\nB-CHANGED-MUST-SURVIVE\n');
  });

  test('B-07: aborting the merge closes Conflict; nothing is saved into the tree', async ({ app, repos, server, page }) => {
    const M = repos.conflict('M');
    await app.boot(M);
    await server.api('/api/repo/merge', { theirRef: 'feat', author: { name: 't', email: 't@t' } });
    await app.openConflict('f.txt');

    await server.api('/api/repo/merge/abort', {});
    await expect(app.tab('conflict')).toBeHidden();
    expect(git(M, 'status', '--porcelain')).toBe('');
    expect(read(M, 'f.txt')).toBe('MAIN\n');
  });

  test('B-04/B-07: switching repo mid-merge closes Conflict', async ({ app, repos, server, page }) => {
    const M = repos.conflict('M');
    const B = repos.make('B');
    await app.boot(M, [B]);
    await server.api('/api/repo/merge', { theirRef: 'feat', author: { name: 't', email: 't@t' } });
    await app.openConflict('f.txt');
    await app.switchTo(B);
    await expect(app.tab('conflict')).toBeHidden();
  });
});

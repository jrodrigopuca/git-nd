// Clone dialog: the exact destination is shown before cloning, a non-empty
// folder is refused up front, and a real clone (from a local git HTTP server,
// no internet needed) ends where the preview said.
import { test, expect, git, write } from './fixtures.js';
import { Git } from 'node-git-server';
import fs from 'node:fs';
import path from 'node:path';

test('clone preview: default, relative and non-empty destinations', async ({ app, repos, page }) => {
  const R = repos.make('R');
  await app.boot(R);
  await page.locator('#btn-clone').click();
  const [url, target] = [page.locator('#modal-backdrop input').nth(0), page.locator('#modal-backdrop input').nth(1)];
  const preview = page.locator('#modal-backdrop p.muted');
  const cloneBtn = page.locator('#modal-backdrop button', { hasText: 'Clone' });

  await url.fill('https://github.com/octocat/Hello-World.git');
  await expect(preview).toHaveText(/^Will be cloned into: .*\/git-nd-repos\/Hello-World$/);
  await target.fill('work/hw');
  await expect(preview).toHaveText(/^Will be cloned into: .*\/git-nd-repos\/work\/hw$/);

  const notEmpty = path.join(repos.root, 'not-empty');
  write(notEmpty, 'keep.txt', 'mine\n');
  await target.fill(notEmpty);
  await expect(preview).toHaveText(new RegExp(`^⚠ ${notEmpty.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} already exists`));
  await expect(cloneBtn).toBeDisabled();
});

test('a real clone lands in the previewed folder, and the toast and tooltip say where', async ({ app, repos, page }) => {
  const served = path.join(repos.root, 'served');
  fs.mkdirSync(served);
  const bare = path.join(served, 'demo.git');
  git(served, 'init', '-q', '--bare', '-b', 'main', bare);
  const src = repos.make('src', { 'hello.txt': 'hello from the local server\n' });
  git(src, 'push', '-q', bare, 'main');

  const gitServer = new Git(served, { autoCreate: false });
  await new Promise((r) => gitServer.listen(0, { type: 'http' }, r));
  try {
    const R = repos.make('R');
    await app.boot(R);
    const dest = path.join(repos.root, 'cloned-here');
    await page.locator('#btn-clone').click();
    await page.locator('#modal-backdrop input').nth(0).fill(`http://127.0.0.1:${gitServer.server.address().port}/demo.git`);
    await page.locator('#modal-backdrop input').nth(1).fill(dest);
    await expect(page.locator('#modal-backdrop p.muted')).toHaveText(`Will be cloned into: ${dest}`);
    await page.locator('#modal-backdrop button', { hasText: 'Clone' }).click();

    await expect(page.locator('.toast', { hasText: `cloned into ${dest}` })).toBeVisible();
    await expect(page.locator('#repo-name')).toHaveAttribute('title', new RegExp(`^${dest.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(fs.readFileSync(path.join(dest, 'hello.txt'), 'utf8')).toBe('hello from the local server\n');
  } finally {
    await gitServer.close();
  }
});

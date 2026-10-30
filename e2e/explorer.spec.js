// Visual review 2, R2-7: Explorer. Recents read by NAME (path secondary, cut
// at the start so the end shows); the path field shows the current folder; a
// repo folder has ONE primary action; repos come before plain folders; cloning
// by URL is right here; no account → a way to connect; the remote list says
// when it is cut ("Showing 40 of N" — it cut silently before).
import fs from 'node:fs';
import path from 'node:path';
import { test, expect } from './fixtures.js';

const explorer = (page) => page.locator('.act-btn[data-view="explorer"]').click();

test('recents: the repo name first, the full path after it, and the open one marked', async ({ app, repos, page }) => {
  const A = repos.make('alpha');
  const B = repos.make('beta');
  await app.boot(A, [B]);
  await explorer(page);
  const rowB = page.locator('#ex-recents li', { hasText: B });
  await expect(rowB.locator('.ex-name')).toHaveText('beta');
  await expect(rowB).toContainText(B); // full path still in the row (fixtures and keyboard use it)
  await expect(page.locator('#ex-recents li', { hasText: A }).locator('.pill-open')).toHaveText('Open now');
  await expect(rowB.locator('.pill-open')).toHaveCount(0);
  // The name is the first thing read.
  const first = await rowB.evaluate((li) => li.innerText.trim().split('\n')[0]);
  expect(first).toBe('beta');
});

test('layout: long paths never push the remote column off screen, and are cut at the start', async ({ app, repos, page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const long = repos.make('a-really-long-repository-name-to-push-the-layout-around-the-page-wide-enough');
  await app.boot(long);
  await explorer(page);
  const { remoteRight, viewport, pathCut, nameShown } = await page.evaluate(() => {
    const remote = document.getElementById('ex-remote-box').getBoundingClientRect();
    const p = document.querySelector('#ex-recents .ex-path');
    return {
      remoteRight: remote.right, viewport: window.innerWidth,
      pathCut: p.scrollWidth > p.clientWidth, // it overflows → ellipsis instead of widening the column
      nameShown: !!document.querySelector('#ex-recents .ex-name')?.getBoundingClientRect().width,
    };
  });
  expect(remoteRight, 'the remote column fits in the window').toBeLessThanOrEqual(viewport);
  expect(pathCut, 'the path is cut, not widening its column').toBe(true);
  expect(nameShown).toBe(true);
});

test('the filter icon does not sit on the placeholder', async ({ app, repos, page }) => {
  await page.route('**/api/auth/status', async (r) => {
    const real = await (await r.fetch()).json();
    await r.fulfill({ json: { providers: real.providers.map((p) => (p.name === 'github' ? { ...p, connected: true, user: { login: 'octo' } } : p)) } });
  });
  await page.route('**/api/providers/list**', (r) => r.fulfill({ json: { provider: 'github', repos: [] } }));
  await app.boot(repos.make('R'));
  await explorer(page);
  const { iconRight, textLeft } = await page.evaluate(() => {
    const box = document.querySelector('#ex-remote-box .ex-search');
    const input = box.querySelector('input');
    return { iconRight: box.querySelector('svg').getBoundingClientRect().right, textLeft: input.getBoundingClientRect().left + parseFloat(getComputedStyle(input).paddingLeft) };
  });
  expect(textLeft).toBeGreaterThan(iconRight);
});

test('the path field shows the END of the path (the current folder) after navigating', async ({ app, repos, page }) => {
  // A long path that overflows the field.
  const deep = path.join(repos.root, 'a-rather-long-folder-name', 'and-another-long-one', 'deeper-still', 'target-folder');
  fs.mkdirSync(deep, { recursive: true });
  await app.boot(repos.make('R'));
  await explorer(page);
  await page.locator('#ex-path').fill(deep);
  await page.locator('#ex-path').press('Enter');
  await expect(page.locator('#ex-path')).toHaveValue(deep);
  await expect.poll(() => page.locator('#ex-path').evaluate((i) => i.scrollWidth > i.clientWidth && i.scrollLeft + i.clientWidth >= i.scrollWidth - 1))
    .toBe(true);
});

test('a folder that is a repo: one primary action; repos listed before folders', async ({ app, repos, page }) => {
  const R = repos.make('R');
  fs.mkdirSync(path.join(repos.root, 'aaa-plain-folder'));
  await app.boot(R);
  await explorer(page);
  // The repos root: R is a repo, aaa-plain-folder is not (and sorts first by name).
  await page.locator('#ex-path').fill(repos.root);
  await page.locator('#ex-path').press('Enter');
  const names = await page.locator('#ex-dirs li .ex-name').allTextContents();
  expect(names.indexOf('R')).toBeLessThan(names.indexOf('aaa-plain-folder'));
  await expect(page.locator('#ex-dirs li', { hasText: 'R' }).first().locator('.ex-go')).toHaveText(/Open/);

  // Inside the repo folder.
  await page.locator('#ex-path').fill(R);
  await page.locator('#ex-path').press('Enter');
  await expect(page.locator('#ex-open-here')).toContainText('is a git repository');
  await expect(page.locator('#view-explorer .btn-primary')).toHaveCount(1);
  await expect(page.locator('#view-explorer .btn-primary')).toHaveText(/Open this repository/);
});

test('clone from URL starts from Explorer', async ({ app, repos, page }) => {
  await app.boot(repos.make('R'));
  await explorer(page);
  await page.locator('#ex-clone').click();
  await expect(page.locator('#modal-backdrop h2')).toHaveText('Clone repository');
});

test('no account: an empty state that leads to Connections', async ({ app, repos, page }) => {
  await app.boot(repos.make('R'));
  await explorer(page);
  await page.locator('#ex-remote-box').getByRole('button', { name: 'Connect an account' }).click();
  await expect(page.locator('.act-btn[data-view="connections"]')).toHaveAttribute('aria-current', 'page');
});

test('remote list: private repos say so in text, and a cut list says "Showing 40 of N"', async ({ app, repos, page }) => {
  await page.route('**/api/auth/status', async (r) => {
    const real = await (await r.fetch()).json();
    await r.fulfill({ json: { providers: real.providers.map((p) => (p.name === 'github' ? { ...p, connected: true, user: { login: 'octo' } } : p)) } });
  });
  const list = Array.from({ length: 55 }, (_, i) => ({
    id: i, name: `repo-${i}`, fullName: `octo/repo-${i}`, private: i === 0, description: i === 0 ? 'The first one' : null,
    cloneUrl: `https://github.com/octo/repo-${i}.git`, webUrl: `https://github.com/octo/repo-${i}`,
  }));
  await page.route('**/api/providers/list**', (r) => r.fulfill({ json: { provider: 'github', repos: list } }));
  await app.boot(repos.make('R'));
  await explorer(page);
  const box = page.locator('#ex-remote-box');
  await expect(box.locator('li.ex-remote-row')).toHaveCount(40);
  await expect(box.locator('.ex-count')).toHaveText('Showing 40 of 55');
  const first = box.locator('li.ex-remote-row').first();
  await expect(first.locator('.pill-private')).toHaveText('Private');
  await expect(first).toContainText('The first one');
  await expect(box.locator('li.ex-remote-row').nth(1).locator('.pill-private')).toHaveCount(0);
  // Filtering updates the count.
  await box.getByRole('searchbox').fill('repo-1');
  await expect(box.locator('.ex-count')).toHaveText('Showing 11 of 11');
});

// Visual review (proposal C): one primary action per screen; destructive
// actions are outlined, set apart, and never the loudest button.
import { test, expect, git, write } from './fixtures.js';

const bg = (locator) => locator.evaluate((el) => getComputedStyle(el).backgroundColor);
const transparent = (c) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';

test('merge view: Abort is outlined and set apart; a disabled Complete is neutral and says why', async ({ app, repos, server, page }) => {
  const M = repos.conflict('M');
  await app.boot(M);
  await server.api('/api/repo/merge', { theirRef: 'feat', author: { name: 't', email: 't@t' } });
  await page.locator('.tab[data-tab="merge"]').click();

  const complete = page.locator('#merge-view button', { hasText: 'Complete merge' });
  const abort = page.locator('#merge-view button', { hasText: 'Abort merge' });
  await expect(complete).toBeDisabled();
  await expect(abort).toHaveText(/Abort merge…$/); // "…": a confirmation follows

  expect(transparent(await bg(abort)), 'Abort has no solid fill').toBe(true);
  const solidPrimary = await page.evaluate(() => {
    const probe = document.createElement('button');
    probe.className = 'btn btn-primary';
    document.body.append(probe);
    const c = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return c;
  });
  expect(await bg(complete), 'a disabled primary is not painted as the main action').not.toBe(solidPrimary);

  const reasonId = await complete.getAttribute('aria-describedby');
  expect(reasonId).toBeTruthy();
  await expect(page.locator(`#${reasonId}`)).toBeVisible();
  await expect(page.locator(`#${reasonId}`)).toContainText(/resolve/i);

  const [c, a] = [await complete.boundingBox(), await abort.boundingBox()];
  expect(a.x - (c.x + c.width), 'Abort sits apart from the primary action').toBeGreaterThan(40);
});

test('merge banner: a status line while the merge view is open; never a second primary', async ({ app, repos, server, page }) => {
  const M = repos.conflict('M');
  await app.boot(M);
  await server.api('/api/repo/merge', { theirRef: 'feat', author: { name: 't', email: 't@t' } });
  await expect(page.locator('#merge-banner')).toBeVisible();

  await expect(page.locator('#btn-merge-view')).toBeVisible();         // elsewhere: a way to get there…
  await expect(page.locator('#btn-merge-view')).not.toHaveClass(/btn-primary/); // …but not another primary
  await page.locator('.tab[data-tab="merge"]').click();
  await expect(page.locator('#btn-merge-view')).toBeHidden();          // already there: just status
  await expect(page.locator('#merge-banner')).toContainText('Merge in progress');
});

test('commit actions: Hard reset is outlined, set apart, and announces its confirmation', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'a.txt': 'a\n' });
  write(R, 'a.txt', 'a\nb\n');
  git(R, 'commit', '-qam', 'second');
  await app.boot(R);
  await page.locator('#commit-list li', { hasText: 'second' }).click();
  const reset = page.locator('#modal-backdrop button', { hasText: 'Hard reset' });
  await expect(reset).toHaveText(/Hard reset…$/);
  expect(transparent(await bg(reset))).toBe(true);
  const close = page.locator('#modal-backdrop button', { hasText: 'Close' });
  const [r, c] = [await reset.boundingBox(), await close.boundingBox()];
  expect(Math.abs(c.x - (r.x + r.width)), 'not right next to Close').toBeGreaterThan(40);
});

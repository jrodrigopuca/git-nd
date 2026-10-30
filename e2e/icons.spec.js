// Visual review 2 (R2-3/R2-5): the brand is the single leaf from the local
// sprite, painted with --brand, and the app loads nothing from other origins
// (it is a local tool: no CDN for icons or fonts).
import { test, expect } from './fixtures.js';

test('the brand is the leaf from the local sprite, in --brand, in both themes', async ({ app, repos, page }) => {
  await app.boot(repos.make('R'));
  const leaf = page.locator('.brand svg.icon');
  await expect(leaf).toBeVisible();
  await expect(leaf).toHaveAttribute('aria-hidden', 'true');
  await expect(leaf.locator('use')).toHaveAttribute('href', '/icons/sprite.svg#i-leaf-brand');
  const box = await leaf.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(16);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, theme);
    const { color, brand } = await leaf.evaluate((s) => {
      const probe = document.createElement('i');
      probe.style.color = 'var(--brand)';
      document.body.append(probe);
      const brandColor = getComputedStyle(probe).color;
      probe.remove();
      return { color: getComputedStyle(s).color, brand: brandColor };
    });
    expect(color, `${theme}: leaf painted with --brand`).toBe(brand);
  }
  // The sprite actually loads (a broken href renders an empty box).
  const status = await page.evaluate(async () => (await fetch('/icons/sprite.svg')).status);
  expect(status).toBe(200);
});

test('nothing is requested from another origin', async ({ app, repos, page }) => {
  const foreign = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!['localhost', '127.0.0.1'].includes(u.hostname) && u.protocol !== 'data:') foreign.push(r.url());
  });
  await app.boot(repos.make('R', { 'a.txt': 'a\n' }));
  await page.waitForLoadState('networkidle');
  expect(foreign).toEqual([]);
});

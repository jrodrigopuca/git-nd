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

test('icon-only controls have a name, and decorative icons are hidden from screen readers', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'a.txt': 'a\n', 'src/b.js': 'b\n' });
  await app.boot(R);
  for (const view of ['repo', 'explorer', 'connections']) {
    await page.locator(`.act-btn[data-view="${view}"]`).click();
    const problems = await page.evaluate(() => {
      const visible = (e) => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
      const out = [];
      for (const b of document.querySelectorAll('button')) {
        if (!visible(b)) continue;
        const name = (b.getAttribute('aria-label') || b.textContent || '').trim();
        if (!name) out.push(`button without a name: ${b.outerHTML.slice(0, 120)}`);
      }
      for (const s of document.querySelectorAll('svg.icon')) {
        if (!s.hasAttribute('aria-label') && s.getAttribute('aria-hidden') !== 'true') out.push(`icon not hidden: ${s.outerHTML.slice(0, 120)}`);
      }
      return out;
    });
    expect(problems, view).toEqual([]);
  }
});

test('the activity bar marks the current view (aria-current), not only with a ring', async ({ app, repos, page }) => {
  await app.boot(repos.make('R'));
  await expect(page.locator('.act-btn[data-view="repo"]')).toHaveAttribute('aria-current', 'page');
  await page.locator('.act-btn[data-view="explorer"]').click();
  await expect(page.locator('.act-btn[data-view="explorer"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('.act-btn[aria-current]')).toHaveCount(1);
  for (const view of ['explorer', 'repo', 'connections']) await expect(page.locator(`.act-btn[data-view="${view}"]`)).toHaveAttribute('aria-label', /.+/);
});

test('the theme button says what it does from the first paint (it showed 🌙 in light mode)', async ({ app, repos, page }) => {
  await page.addInitScript(() => localStorage.setItem('gitnd-theme', 'light'));
  await app.boot(repos.make('R'));
  const btn = page.locator('#btn-theme');
  await expect(btn).toHaveAttribute('aria-label', 'Switch to dark theme');
  await btn.click();
  await expect(btn).toHaveAttribute('aria-label', 'Switch to light theme');
});

test('toasts carry their kind as an icon, not a ✔ in the text', async ({ app, repos, page }) => {
  await app.boot(repos.make('R'));
  await page.evaluate(async () => (await import('/js/ui.js')).toast('Done', 'success'));
  const t = page.locator('.toast.success').last();
  await expect(t).toHaveText('Done');
  await expect(t.locator('svg.icon use')).toHaveAttribute('href', '/icons/sprite.svg#i-circle-check');
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

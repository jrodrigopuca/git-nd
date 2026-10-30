// Visual review V-E: below 980px the right panel (Changes, staging, commit)
// used to vanish — you could not commit on a small laptop. It is now a drawer
// opened from the top bar.
import { test, expect, git, write } from './fixtures.js';

test.describe('narrow window (960px)', () => {
  test.use({ viewport: { width: 960, height: 800 } });

  test('V-E: the panel opens from the top bar, and staging + committing works in it', async ({ app, repos, page }) => {
    const R = repos.make('R', { 'a.txt': 'a\n' });
    write(R, 'a.txt', 'a\nchanged\n');
    await app.boot(R);

    const toggle = page.locator('#btn-panel');
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#panel-badge')).toHaveText('1');      // changes count on the button
    await expect(page.locator('#commit-msg')).toBeHidden();         // closed: not shown…
    expect(await page.locator('#rightbar').evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden'); // …nor focusable

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#commit-msg')).toBeVisible();
    expect(await page.evaluate(() => document.getElementById('rightbar').contains(document.activeElement)), 'focus moves into the panel').toBe(true);

    await app.rowAction('unstaged-list', 'a.txt', 'Stage');
    await page.locator('#commit-msg').fill('committed from the drawer');
    await page.locator('#btn-commit').click();
    await expect.poll(() => git(R, 'log', '-1', '--format=%s')).toBe('committed from the drawer');
  });

  test('V-E: Escape and the backdrop close it; focus returns to the toggle', async ({ app, repos, page }) => {
    await app.boot(repos.make('R'));
    const toggle = page.locator('#btn-panel');
    await toggle.click();
    await expect(page.locator('#commit-msg')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#commit-msg')).toBeHidden();
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('btn-panel');

    await toggle.click();
    await page.locator('#drawer-scrim').click({ position: { x: 20, y: 400 } });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await page.locator('#btn-panel-close').click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  test('V-E: widening the window with the drawer open restores the normal column', async ({ app, repos, page }) => {
    await app.boot(repos.make('R'));
    await page.locator('#btn-panel').click();
    await page.setViewportSize({ width: 1440, height: 800 });
    await expect(page.locator('#btn-panel')).toBeHidden();
    await expect(page.locator('#drawer-scrim')).toBeHidden();
    await expect(page.locator('#commit-msg')).toBeVisible();
    // The right-hand column again — inside the window, not an overlay over the graph.
    await expect.poll(async () => {
      const box = await page.locator('#rightbar').boundingBox();
      return box.x > 1000 && box.x + box.width <= 1440;
    }, { timeout: 2000 }).toBe(true);
    await page.setViewportSize({ width: 960, height: 800 });
    await expect(page.locator('#commit-msg')).toBeHidden(); // back to narrow: closed
  });
});

test('V-E: on a wide window nothing changes (regression)', async ({ app, repos, page }) => {
  await app.boot(repos.make('R'));
  await expect(page.locator('#btn-panel')).toBeHidden();
  await expect(page.locator('#commit-msg')).toBeVisible();
  await expect(page.locator('#btn-panel-close')).toBeHidden();
});

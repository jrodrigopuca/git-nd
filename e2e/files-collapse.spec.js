// Visual review 2, F1: the Files sidebar collapses to a 40px rail so the
// graph gets the width. One toggle that never moves (focus is never lost),
// state that survives a reload, independent from the <980px drawer.
import { test, expect, read } from './fixtures.js';

const width = (page, sel) => page.locator(sel).evaluate((e) => e.getBoundingClientRect().width);

/** Drops a file the way the browser does: dragover + drop with a real DataTransfer. */
async function dropFile(page, selector, name, content) {
  await page.locator(selector).evaluate((target, [n, c]) => {
    const dt = new DataTransfer();
    dt.items.add(new File([c], n, { type: 'text/plain' }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  }, [name, content]);
}

test.describe('Files sidebar collapse (1180px)', () => {
  test.use({ viewport: { width: 1180, height: 800 } });

  test('collapses to a rail, the graph gains the width, and focus stays on the toggle', async ({ app, repos, page }) => {
    await app.boot(repos.make('R', { 'a.txt': 'a\n' }));
    const toggle = page.locator('#btn-files-toggle');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-controls', 'sidebar');
    const graphBefore = await width(page, '#graph-wrap');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#tree')).toBeHidden();
    await expect(page.locator('#btn-refresh-tree')).toBeHidden();
    expect(await width(page, '#sidebar')).toBeLessThanOrEqual(40);
    await expect.poll(() => width(page, '#graph-wrap')).toBeGreaterThanOrEqual(graphBefore + 200);
    expect(await page.evaluate(() => document.activeElement?.id), 'focus stays on the toggle').toBe('btn-files-toggle');

    // The graph re-fits to the new width: its svg follows the wrap, no clipped date.
    await expect.poll(async () => {
      const wrap = await page.locator('#graph-wrap').evaluate((w) => w.clientWidth - 20);
      const svg = await page.locator('#graph-wrap svg').evaluate((s) => Number(s.getAttribute('width')));
      return Math.abs(svg - wrap) <= 2;
    }).toBe(true);

    await page.keyboard.press('Enter');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.locator('#tree')).toBeVisible();
  });

  test('collapsed, Tab never lands inside the hidden tree', async ({ app, repos, page }) => {
    await app.boot(repos.make('R', { 'a.txt': 'a\n' }));
    await page.locator('#btn-files-toggle').click();
    await page.locator('#btn-files-toggle').focus();
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('#tree') || document.activeElement?.id === 'btn-refresh-tree');
      expect(inside).toBe(false);
    }
  });

  test('the state survives a reload; with nothing saved it starts expanded', async ({ app, repos, page }) => {
    const R = repos.make('R', { 'a.txt': 'a\n' });
    await app.boot(R);
    await expect(page.locator('#btn-files-toggle')).toHaveAttribute('aria-expanded', 'true');
    await page.locator('#btn-files-toggle').click();
    await page.reload();
    await expect(page.locator('#btn-files-toggle')).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('#tree')).toBeHidden();
  });

  test('dropping a file on the collapsed rail adds it at the repo root', async ({ app, repos, page }) => {
    const R = repos.make('R', { 'a.txt': 'a\n' });
    await app.boot(R);
    await page.locator('#btn-files-toggle').click();
    await dropFile(page, '#sidebar', 'dropped.txt', 'hello\n');
    await expect.poll(() => { try { return read(R, 'dropped.txt'); } catch { return null; } }).toBe('hello\n');
  });
});

test.describe('dropping files on the tree (R2-4)', () => {
  // The drop used to tell folders from files by the twisty's TEXT (▶/▼):
  // with an SVG twisty that text is empty and every drop would go to the
  // parent. These guard the folder detection whatever the twisty looks like.
  test('on a folder row: the file lands inside that folder', async ({ app, repos, page }) => {
    const R = repos.make('R', { 'src/a.txt': 'a\n' });
    await app.boot(R);
    await dropFile(page, '#tree .tree-node[data-path="src"] > .tree-row', 'in-folder.txt', 'x\n');
    await expect.poll(() => { try { return read(R, 'src/in-folder.txt'); } catch { return null; } }).toBe('x\n');
  });

  test('on a file inside a folder: the file lands next to it', async ({ app, repos, page }) => {
    const R = repos.make('R', { 'src/a.txt': 'a\n' });
    await app.boot(R);
    await page.locator('#tree .tree-node[data-path="src"] > .tree-row').click();
    await dropFile(page, '#tree .tree-node[data-path="src/a.txt"] > .tree-row', 'sibling.txt', 'y\n');
    await expect.poll(() => { try { return read(R, 'src/sibling.txt'); } catch { return null; } }).toBe('y\n');
  });

  test('with an empty twisty (as an SVG one would be), a folder is still a folder', async ({ app, repos, page }) => {
    const R = repos.make('R', { 'src/a.txt': 'a\n' });
    await app.boot(R);
    await page.evaluate(() => document.querySelectorAll('#tree .twisty').forEach((t) => { t.textContent = ''; }));
    await dropFile(page, '#tree .tree-node[data-path="src"] > .tree-row', 'svg-twisty.txt', 'z\n');
    await expect.poll(() => { try { return read(R, 'src/svg-twisty.txt'); } catch { return null; } }).toBe('z\n');
  });
});

test.describe('Files collapse below 980px', () => {
  test.use({ viewport: { width: 900, height: 800 } });

  test('is independent from the changes drawer', async ({ app, repos, page }) => {
    await app.boot(repos.make('R', { 'a.txt': 'a\n' }));
    await page.locator('#btn-files-toggle').click();
    await expect(page.locator('#btn-panel')).toHaveAttribute('aria-expanded', 'false');
    await page.locator('#btn-panel').click();
    await expect(page.locator('#commit-msg')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#commit-msg')).toBeHidden();
    await expect(page.locator('#btn-files-toggle')).toHaveAttribute('aria-expanded', 'false');
  });
});

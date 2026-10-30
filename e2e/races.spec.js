// BACKLOG B-15 / B-18: responses that arrive late must not win. The races are
// forced deterministically by holding a real server response with page.route.
import { test, expect, git, write } from './fixtures.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Route handler that holds the next `n` matching responses for `ms` (already computed by the server). */
function holder() {
  let pending = 0;
  let ms = 0;
  return {
    hold(n, delay) { pending = n; ms = delay; },
    handler: async (route) => {
      if (pending <= 0) return route.continue();
      pending--;
      const response = await route.fetch();
      await sleep(ms);
      await route.fulfill({ response });
    },
  };
}

test('B-15: a double click on a folder while it loads leaves a coherent tree', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'dir/inner.txt': 'i\n', 'a.txt': 'a\n' });
  await app.boot(R);
  const tree = holder();
  await page.route((url) => url.pathname === '/api/repo/tree' && url.searchParams.get('path') === 'dir', tree.handler);
  const node = page.locator('#tree .tree-node[data-path="dir"]');
  const row = node.locator(':scope > .tree-row');
  const children = node.locator(':scope > .tree-children');

  tree.hold(1, 700);
  await row.click();      // expand: its children load is held
  await row.click();      // collapse while loading
  await sleep(1000);      // the held load lands now
  // The chevron's rotation follows aria-expanded (CSS), so that is the state to check.
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await expect(children).toHaveCount(0);

  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
  await expect(children).toHaveCount(1);
  await expect(children.locator('.tree-node')).toHaveCount(1);
});

test('B-18: an older refresh answered last does not repaint old state', async ({ app, repos, page, server }) => {
  const R = repos.make('R', { 'a.txt': 'a\n' });
  write(R, 'a.txt', 'a\nchanged\n');
  await app.boot(R);
  await expect(page.locator('#unstaged-list [title="a.txt"]')).toBeVisible();
  const status = holder();
  await page.route((url) => url.pathname === '/api/repo/status', status.handler);

  status.hold(1, 1800);
  await page.locator('#btn-refresh-tree').click();     // refresh #1: its (old) status is held
  await sleep(250);
  await server.api('/api/repo/stage', { path: 'a.txt' });
  await page.locator('#btn-refresh-tree').click();     // refresh #2: fresh status
  await sleep(2500);                                   // #1 lands last
  await expect(page.locator('#staged-list [title="a.txt"]')).toBeVisible();
  await expect(page.locator('#unstaged-list [title="a.txt"]')).toHaveCount(0);
  expect(git(R, 'diff', '--cached', '--name-only')).toBe('a.txt');
});

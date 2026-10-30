// The paged, virtualized graph (docs/adr/0001): first page, "Load more",
// constant DOM size, no rebuild on unchanged refreshes, and branches moving
// while paging. Uses a synthetic repo built in a second with git fast-import
// (the big-repo PERFORMANCE check is separate and manual).
import { test, expect, git, write, syntheticRepo } from './fixtures.js';

const footer = (page) => page.locator('#graph-footer');
const loadMore = async (page) => {
  const before = await footer(page).textContent();
  await page.locator('#btn-graph-more').click();
  await expect(footer(page)).not.toHaveText(before);
  await expect(page.locator('#btn-graph-more, #graph-footer span')).not.toHaveText('Loading…');
};

test('graph: paged, virtualized, and stable across refreshes and moving branches', async ({ app, repos, page }) => {
  const R = syntheticRepo(repos.root, { commits: 900, branchEvery: 45 });
  const total = Number(git(R, 'rev-list', '--count', '--branches', 'HEAD'));
  await app.boot(R);

  // First page, drawn virtually: far fewer rows in the DOM than loaded.
  await expect(footer(page)).toHaveText(/Load more commits \(200 shown\)/);
  expect(await page.locator('#graph-wrap .graph-row').count()).toBeLessThan(100);
  await loadMore(page);
  await expect(footer(page)).toHaveText(/\(400 shown\)/);

  // Tags arrive after the first page and are drawn where they are.
  await page.locator('#graph-wrap').evaluate((w) => { w.scrollTop = 10 + 300 * 28 - 200; });
  await expect(page.locator('#graph-wrap text', { hasText: '🏷 v2' })).toBeVisible();

  // A watcher refresh with unchanged refs must not rebuild the graph.
  const svg = await page.locator('#graph-wrap svg').elementHandle();
  write(R, 'untracked-probe.txt', 'x\n');
  await page.waitForTimeout(2000);
  expect(await svg.evaluate((el) => el.isConnected)).toBe(true);
  await expect(footer(page)).toHaveText(/\(400 shown\)/);

  // Branches move while paging: the shown depth is kept and the new branch is drawn.
  git(R, 'branch', 'zz-new', 'main~5');
  await loadMore(page);
  await expect(footer(page)).toHaveText(/\(600 shown\)/);
  await page.locator('#graph-wrap').evaluate((w) => { w.scrollTop = 0; });
  await expect(page.locator('#graph-wrap text', { hasText: 'zz-new' })).toBeVisible();

  // All the way to the first commit, with the DOM still small.
  while (await page.locator('#btn-graph-more').count()) await loadMore(page);
  await expect(footer(page)).toHaveText(`All ${total} commits loaded`);
  expect(await page.locator('#graph-wrap svg *').count()).toBeLessThan(3000);
  await page.locator('#graph-wrap').evaluate((w) => { w.scrollTop = w.scrollHeight; });
  await expect(page.locator('#graph-wrap .graph-row', { hasText: 'c1' }).last()).toBeVisible();
});

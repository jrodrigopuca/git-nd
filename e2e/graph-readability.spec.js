// Visual review V-D: a graph that is easy to read — no dead gutter, width that
// follows the panel (no clipped dates), aligned hash/date columns, relative
// dates, and a selected row that stays selected.
import { test, expect, git, write, syntheticRepo } from './fixtures.js';

/** Repo with a few lanes: main plus two side branches, recent dates. */
function lanesRepo(repos) {
  const R = repos.make('R', { 'a.txt': 'a\n' });
  for (const b of ['feat-1', 'feat-2']) {
    git(R, 'checkout', '-q', '-b', b, 'main');
    write(R, `${b}.txt`, `${b}\n`);
    git(R, 'add', '-A');
    git(R, 'commit', '-qm', `work on ${b}`);
  }
  git(R, 'checkout', '-q', 'main');
  write(R, 'a.txt', 'a\nmain\n');
  git(R, 'commit', '-qam', 'main moves on');
  return R;
}

const svgWidth = (page) => page.locator('#graph-wrap svg').evaluate((s) => Number(s.getAttribute('width')));

test('V-D: no dead gutter between the lanes in use and the text', async ({ app, repos, page }) => {
  await app.boot(lanesRepo(repos));
  const gap = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#graph-wrap .graph-row')];
    const laneRight = Math.max(...rows.map((g) => Number(g.querySelector(':scope > circle').getAttribute('cx'))));
    const avatarLeft = Math.min(...rows.map((g) => Number(g.querySelector('circle[r="9"]').getAttribute('cx')) - 9)); // the author avatar
    return avatarLeft - laneRight;
  });
  expect(gap).toBeGreaterThan(0);
  // One spare lane (16px) by design, so loading more rarely shifts the text;
  // before V-D this gap was ~90px.
  expect(gap, 'text starts right after the lanes in use').toBeLessThan(50);
});

test('V-D: the graph width follows the panel, and dates are never clipped', async ({ app, repos, page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await app.boot(lanesRepo(repos));
  for (const width of [1180, 1600]) {
    await page.setViewportSize({ width, height: 800 });
    await expect.poll(async () => {
      const wrap = await page.locator('#graph-wrap').evaluate((w) => w.clientWidth - 20); // minus its padding
      return Math.abs((await svgWidth(page)) - wrap) <= 2;
    }, { message: `svg width follows #graph-wrap at ${width}px` }).toBe(true);
    const overflow = await page.evaluate(() => {
      const svg = document.querySelector('#graph-wrap svg');
      const w = Number(svg.getAttribute('width'));
      return [...svg.querySelectorAll('.graph-date')].filter((t) => { const b = t.getBBox(); return b.x + b.width > w + 0.5 || b.x < 0; }).length;
    });
    expect(overflow, `no clipped date at ${width}px`).toBe(0);
  }
});

test('V-D: hash and date are aligned columns; dates are relative, full date on hover', async ({ app, repos, page }) => {
  await app.boot(lanesRepo(repos));
  const cols = await page.evaluate(() => ({
    hashX: [...new Set([...document.querySelectorAll('#graph-wrap .graph-hash')].map((t) => t.getAttribute('x')))],
    dateX: [...new Set([...document.querySelectorAll('#graph-wrap .graph-date')].map((t) => t.getAttribute('x')))],
    dates: [...document.querySelectorAll('#graph-wrap .graph-date')].map((t) => t.firstChild.textContent),
    titles: [...document.querySelectorAll('#graph-wrap .graph-date title')].map((t) => t.textContent),
  }));
  expect(cols.hashX).toHaveLength(1);
  expect(cols.dateX).toHaveLength(1);
  for (const d of cols.dates) expect(d).toMatch(/just now|min ago|h ago/);
  for (const t of cols.titles) expect(t).toMatch(/\d{1,2}:\d{2}/); // full date with time
  // Same wording in the History list for the same commit.
  const top = await page.locator('#commit-list li').first().locator('span[title]').textContent();
  expect(cols.dates).toContain(top);
});

test('V-D: the selected row stays selected — after closing the commit and through virtual scrolling', async ({ app, repos, page }) => {
  const R = syntheticRepo(repos.root, { commits: 300, branchEvery: 1000, name: 'sel' });
  await app.boot(R);
  const row = (msg) => page.locator('#graph-wrap .graph-row', { hasText: new RegExp(`^.*${msg}`) }).filter({ has: page.locator('text.graph-msg', { hasText: new RegExp(`^${msg}$`) }) });
  await row('c298').click();
  await page.locator('#modal-backdrop button', { hasText: 'Close' }).click();
  await expect(row('c298')).toHaveClass(/selected/);
  await expect(page.locator('#graph-wrap .graph-row.selected')).toHaveCount(1);

  await page.locator('#graph-wrap').evaluate((w) => { w.scrollTop = 200 * 28; });
  await page.waitForTimeout(200);
  await page.locator('#graph-wrap').evaluate((w) => { w.scrollTop = 0; });
  await expect(row('c298')).toHaveClass(/selected/); // redrawn by the virtual list, still selected

  await row('c297').click();
  await page.locator('#modal-backdrop button', { hasText: 'Close' }).click();
  await expect(page.locator('#graph-wrap .graph-row.selected')).toHaveCount(1);
  await expect(row('c297')).toHaveClass(/selected/);
});

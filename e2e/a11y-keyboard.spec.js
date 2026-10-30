// BACKLOG B-24: everything clickable is also reachable and operable with the
// keyboard — lists built with el(), the file tree, and the (virtualized) graph.
import { test, expect, git, write, syntheticRepo } from './fixtures.js';

const active = (page) => page.evaluate(() => {
  const a = document.activeElement;
  return { tag: a?.tagName, role: a?.getAttribute('role'), cls: a?.getAttribute('class'), text: a?.textContent?.trim().slice(0, 40) };
});

test('el(): a clickable non-control is focusable, named a button, and fires on Enter/Space — but not for a nested button', async ({ app, repos, page }) => {
  await app.boot(repos.make('R'));
  const r = await page.evaluate(async () => {
    const { el } = await import('/js/ui.js');
    const log = [];
    const inner = el('button', { onclick: () => log.push('inner') }, 'inner');
    const li = el('li', { onclick: () => log.push('row') }, 'row ', inner);
    document.body.append(li);
    const key = (target, k) => target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
    li.focus();
    const focused = document.activeElement === li;
    key(li, 'Enter');
    key(li, ' ');
    inner.focus();
    key(inner, 'Enter'); // the button's own Enter is the browser's job; the row must NOT fire
    li.remove();
    return { focused, tabIndex: li.tabIndex, role: li.getAttribute('role'), log };
  });
  expect(r.focused).toBe(true);
  expect(r.tabIndex).toBe(0);
  expect(r.role).toBe('button');
  expect(r.log).toEqual(['row', 'row']);
});

test('keyboard: open a recent repo from Explorer', async ({ app, repos, page }) => {
  const A = repos.make('A');
  const B = repos.make('B', { 'only-in-b.txt': 'b\n' });
  await app.boot(A, [B]);
  await page.locator('.act-btn[data-view="explorer"]').click();
  await page.locator('#ex-recents li', { hasText: B }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#repo-name')).toHaveAttribute('title', new RegExp(`^${B.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
});

test('keyboard: history → commit → one of its files → diff', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'a.txt': 'a\n' });
  write(R, 'a.txt', 'a\nsecond\n');
  git(R, 'commit', '-qam', 'second commit');
  await app.boot(R);
  await page.locator('#commit-list li', { hasText: 'second commit' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#modal-backdrop h2')).toHaveText('second commit');
  await page.locator('#modal-backdrop .file-list li', { hasText: 'a.txt' }).focus();
  await page.keyboard.press(' '); // Space works too
  await expect(app.tab('diff')).toHaveClass(/active/);
});

test('keyboard: switch branch from the branch picker', async ({ app, repos, page }) => {
  const R = repos.make('R');
  git(R, 'branch', 'feature-x');
  await app.boot(R);
  await page.locator('#btn-branch').click();
  await page.locator('#modal-backdrop li', { hasText: 'feature-x' }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => git(R, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('feature-x');
});

test('keyboard: the file tree expands folders and opens files', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'dir/inner.txt': 'inner\n', 'top.txt': 't\n' });
  await app.boot(R);
  const dirRow = page.locator('#tree .tree-node[data-path="dir"] > .tree-row');
  await dirRow.focus();
  await expect(dirRow).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await expect(dirRow).toHaveAttribute('aria-expanded', 'true');
  const fileRow = page.locator('#tree .tree-node[data-path="dir/inner.txt"] > .tree-row');
  await fileRow.focus();
  await page.keyboard.press('Enter');
  await expect(app.tab('file')).toHaveClass(/active/);
  await expect(page.locator('#file-editor')).toHaveValue('inner\n');
});

test('keyboard: the graph is ONE tab stop; arrows walk rows, scrolling the virtual list; Enter opens the commit', async ({ app, repos, page }) => {
  const R = syntheticRepo(repos.root, { commits: 300, branchEvery: 1000, name: 'g' });
  await app.boot(R);
  const tabbable = page.locator('#graph-wrap .graph-row[tabindex="0"]');
  await expect(tabbable).toHaveCount(1); // roving tabindex: one stop for the whole graph
  await tabbable.focus();
  expect((await active(page)).text).toContain('c300');
  for (let i = 0; i < 120; i++) await page.keyboard.press('ArrowDown'); // far past the drawn band
  const now = await active(page);
  expect(now.cls).toContain('graph-row');
  expect(now.text).toContain('c180');
  await expect(page.locator('#graph-wrap .graph-row[tabindex="0"]')).toHaveCount(1);
  await page.keyboard.press('ArrowUp');
  expect((await active(page)).text).toContain('c181');
  await page.keyboard.press('Enter');
  await expect(page.locator('#modal-backdrop h2')).toHaveText('c181');
});

test('keyboard focus is visible on list rows and graph rows', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'a.txt': 'a\n' });
  await app.boot(R);
  await page.locator('#commit-list li').first().focus();
  await page.keyboard.press('ArrowDown'); // any key press switches Chrome to keyboard-focus mode
  await page.locator('#commit-list li').first().focus();
  const li = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle);
  expect(li).not.toBe('none');
  await page.locator('#graph-wrap .graph-row[tabindex="0"]').focus();
  const rect = await page.evaluate(() => getComputedStyle(document.activeElement.querySelector('rect')).stroke);
  expect(rect).not.toBe('none');
});

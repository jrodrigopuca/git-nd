// BACKLOG B-23: the Changes list works with the keyboard alone — every row's
// file name and actions are reachable with Tab, visible when focused, named for
// screen readers, and operable with Enter.
import { test, expect, git, write } from './fixtures.js';

const focusedTitle = (page) => page.evaluate(() => document.activeElement?.getAttribute('title'));
const focusedName = (page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label'));
/** The focused button is actually shown: its actions box has width and the button is not clipped away. */
const shownWidth = (locator) => locator.evaluate((el) => Math.min(el.closest('.actions').getBoundingClientRect().width, el.getBoundingClientRect().width));

test('B-23: open a diff and stage a file with the keyboard only', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'README.md': 'r\n' });
  write(R, 'new.txt', 'hello\n');
  await app.boot(R);

  // The file name is focusable and opens its diff with Enter.
  const name = page.locator('#unstaged-list .fname[title="new.txt"]');
  await name.focus();
  expect(await focusedTitle(page)).toBe('new.txt');
  await page.keyboard.press('Enter');
  await expect(app.tab('diff')).toHaveClass(/active/);

  // Tab reaches the row's Stage button; it shows while focused and says what it does.
  await name.focus();
  await page.keyboard.press('Tab');
  expect(await focusedTitle(page)).toBe('Stage');
  expect(await focusedName(page)).toBe('Stage new.txt');
  const stage = page.locator('#unstaged-list li', { has: page.locator('.fname[title="new.txt"]') }).getByTitle('Stage', { exact: true });
  expect(await shownWidth(stage)).toBeGreaterThan(10);
  await page.keyboard.press('Enter');
  await expect(page.locator('#staged-list .fname[title="new.txt"]')).toBeVisible();
  expect(git(R, 'diff', '--cached', '--name-only')).toBe('new.txt');

  // And Discard is reachable too, with its confirmation.
  write(R, 'README.md', 'r\nedited\n');
  const readme = page.locator('#unstaged-list .fname[title="README.md"]');
  await expect(readme).toBeVisible();
  await readme.focus();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  expect(await focusedTitle(page)).toBe('Discard changes');
  expect(await focusedName(page)).toBe('Discard changes to README.md');
});

test('B-23: a keyboard-focused button shows a visible focus ring', async ({ app, repos, page }) => {
  const R = repos.make('R', { 'README.md': 'r\n' });
  write(R, 'README.md', 'r\nchanged\n');
  await app.boot(R);
  await page.locator('#unstaged-list .fname[title="README.md"]').focus();
  await page.keyboard.press('Tab'); // keyboard focus → :focus-visible
  const outline = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement);
    return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
  });
  expect(outline.style).not.toBe('none');
  expect(outline.width).toBeGreaterThan(0);
});

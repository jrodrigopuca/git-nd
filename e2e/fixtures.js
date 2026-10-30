// Shared E2E fixtures. Every test builds its own repos with the git CLI (the
// app never needs it) and asserts against git itself — no hardcoded counts.
import { test as base, expect } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export { expect };

const ROOT = path.resolve(import.meta.dirname, '..');

const freePort = () => new Promise((resolve, reject) => {
  const srv = net.createServer();
  srv.unref();
  srv.on('error', reject);
  srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
});

/** Run git in `dir` with a fixed identity; returns trimmed stdout. */
export function git(dir, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd: dir, encoding: 'utf8',
  }).trim();
}

export function write(dir, p, content) {
  fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
  fs.writeFileSync(path.join(dir, p), content);
}

export const read = (dir, p) => fs.readFileSync(path.join(dir, p), 'utf8');

/**
 * A repo with `commits` linear commits ("c1"…"cN", strictly increasing dates,
 * so the graph order is deterministic), a branch every `branchEvery` commits
 * and a tag every 300 — built in a second with git fast-import.
 */
export function syntheticRepo(root, { commits = 900, branchEvery = 45, name = 'big' } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  let stream = '';
  for (let i = 1; i <= commits; i++) {
    const ts = 1_600_000_000 + i * 60;
    const content = `line ${i}\n`;
    stream += `commit refs/heads/main\nmark :${i}\ncommitter t <t@t> ${ts} +0000\ndata ${`c${i}`.length}\nc${i}\n`;
    if (i > 1) stream += `from :${i - 1}\n`;
    stream += `M 100644 inline f.txt\ndata ${Buffer.byteLength(content)}\n${content}\n`;
    if (i % branchEvery === 0) stream += `reset refs/heads/b${i}\nfrom :${i}\n\n`;
    if (i % 300 === 0) stream += `reset refs/tags/v${i / 300}\nfrom :${i}\n\n`;
  }
  execFileSync('git', ['fast-import', '--quiet'], { cwd: dir, input: stream });
  git(dir, 'checkout', '-q', '-f', 'main');
  return dir;
}

/** Repo-local git identity, like a user who has git configured: the commit box gets an author. */
export function identity(dir) {
  git(dir, 'config', 'user.name', 'E2E User');
  git(dir, 'config', 'user.email', 'e2e@example.invalid');
}

export const test = base.extend({
  /** One git-nd server per worker: random port, throwaway HOME (never the user's ~/.git-nd). */
  server: [async ({}, use) => {
    const port = await freePort();
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnd-e2e-home-'));
    const proc = spawn(process.execPath, ['server/index.js'], {
      cwd: ROOT, env: { ...process.env, PORT: String(port), HOME: home }, stdio: 'ignore',
    });
    const url = `http://localhost:${port}`;
    for (let i = 0; i < 100; i++) {
      try { await fetch(`${url}/`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    /** Call the API like the UI does (it requires X-GitND). */
    const api = async (p, body) => {
      const res = await fetch(`${url}${p}`, {
        method: body ? 'POST' : 'GET',
        headers: { 'X-GitND': '1', ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      return res.json();
    };
    await use({ url, port, home, api });
    // Wait for the server to really exit (SIGKILL after 5 s): a child left
    // running keeps the worker alive — one full run hung on teardown once.
    if (proc.exitCode === null) {
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      const timer = setTimeout(() => proc.kill('SIGKILL'), 5000);
      await exited;
      clearTimeout(timer);
    }
    fs.rmSync(home, { recursive: true, force: true });
  }, { scope: 'worker' }],

  /** Builders for throwaway repos under this test's output dir. */
  repos: async ({}, use, testInfo) => {
    const root = testInfo.outputPath('repos');
    fs.mkdirSync(root, { recursive: true });
    await use({
      root,
      /** New repo with `files` committed on main. */
      make(name, files = { 'README.md': 'readme\n' }) {
        const dir = path.join(root, name);
        fs.mkdirSync(dir, { recursive: true });
        git(dir, 'init', '-q', '-b', 'main');
        identity(dir);
        for (const [p, c] of Object.entries(files)) write(dir, p, c);
        git(dir, 'add', '-A');
        git(dir, 'commit', '-q', '-m', 'init');
        return dir;
      },
      /** Repo where main and feat both change f.txt → merging feat conflicts. */
      conflict(name) {
        const dir = this.make(name, { 'f.txt': 'base\n' });
        git(dir, 'checkout', '-q', '-b', 'feat');
        write(dir, 'f.txt', 'FEAT\n');
        git(dir, 'commit', '-qam', 'feat');
        git(dir, 'checkout', '-q', 'main');
        write(dir, 'f.txt', 'MAIN\n');
        git(dir, 'commit', '-qam', 'main');
        return dir;
      },
    });
  },

  /** The app in a page, with helpers to drive it the way a user does. */
  app: async ({ page, server }, use) => {
    const app = {
      page,
      /** Open `dir` on the server (as another client would) and load the UI on it. */
      async boot(dir, recents = []) {
        await server.api('/api/repo/open', { dir });
        await page.goto(server.url);
        await page.waitForFunction(() => !!document.documentElement.dataset.theme);
        await page.evaluate((list) => localStorage.setItem('gitnd-recents', JSON.stringify(list)), [...recents, dir]);
        await expect(page.locator('#repo-name')).toHaveAttribute('title', new RegExp(`^${escape(dir)}`));
      },
      /** Switch repo from THIS tab, through Explorer → Recents. */
      async switchTo(dir) {
        await page.locator('.act-btn[data-view="explorer"]').click();
        await page.locator('#ex-recents li', { hasText: dir }).click();
        await expect(page.locator('#repo-name')).toHaveAttribute('title', new RegExp(`^${escape(dir)}`));
      },
      tab: (name) => page.locator(`.tab[data-tab="${name}"]`),
      /** Open a conflicted file the way a user does: Merge tab → the file. */
      async openConflict(file) {
        await page.locator('.tab[data-tab="merge"]').click();
        await page.locator('#merge-view [title="' + file + '"]').click();
        await expect(page.locator('.tab[data-tab="conflict"]')).toBeVisible();
      },
      changed: (file) => page.locator(`.fname[title="${file}"]`),
      /** A row action (Stage / Unstage / Discard changes): shown on hover, so hover first like a user. */
      async rowAction(list, file, title) {
        const row = page.locator(`#${list} li`, { has: page.locator(`.fname[title="${file}"]`) });
        await row.hover();
        await row.getByTitle(title, { exact: true }).click();
      },
      saveShortcut: () => page.keyboard.press('Control+s'),
    };
    await use(app);
  },
});

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

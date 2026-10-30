import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import isoGit from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import * as Diff from 'diff';
import { repoState, AppError } from './state.js';
import { getSettings, saveSettings } from './settings.js';
import { tokenStore } from './tokenStore.js';
import { createHash } from 'node:crypto';
// onAuth for push/pull/clone (exact host + https, from the URL actually requested),
// and the network options that keep a repo-configured proxy out of the way.
import { authFor, NO_REPO_PROXY } from './credentials.js';
import { partitionReachable, GraphWalk } from './commitWalk.js';

/**
 * isomorphic-git with the open repo's shared cache injected into EVERY call
 * on that repo — reads and writes alike (BACKLOG B-19). Reads used the cache
 * while git.add/remove/resetIndex/updateIndex wrote the index without it;
 * isomorphic-git spots a changed index by mtime in seconds + inode + size, so
 * a same-size write in the same second was invisible to the next cached read
 * (an empty commit after unstage, a discard restoring a stale version).
 * Going through the same cache, a write updates the copy the next read uses.
 * Calls on another dir (a clone target) or with an explicit `cache` are left
 * as they are; argument-less helpers (git.STAGE()) pass straight through.
 */
const git = new Proxy(isoGit, {
  get(target, key) {
    const value = target[key];
    if (typeof value !== 'function') return value;
    return (args, ...rest) => {
      const injectable = args && typeof args === 'object' && !('cache' in args)
        && repoState.dir && args.dir === repoState.dir;
      return value.call(target, injectable ? { ...args, cache: repoState.gitCache() } : args, ...rest);
    };
  },
});

const IGNORED_DIRS = new Set(['.git']);

/* ---------------------------------------------------------------- auth --- */


/** Fetch all branches; if the remote HEAD dangles, fall back to just ours. */
async function fetchRemote(dir, remote, url, tokens, branch) {
  const onAuth = authFor(tokens);
  try {
    await git.fetch({ fs, http, dir, remote, onAuth, ...NO_REPO_PROXY });
  } catch (err) {
    if (err.code === 'NotFoundError' && branch) {
      await git.fetch({ fs, http, dir, remote, onAuth, ref: branch, singleBranch: true, ...NO_REPO_PROXY });
    } else {
      throw err;
    }
  }
}

async function remoteUrl(dir, remote = 'origin') {
  const remotes = await git.listRemotes({ fs, dir });
  const found = remotes.find((r) => r.remote === remote);
  if (!found) throw new AppError(`Remote "${remote}" does not exist`, 400);
  return found.url;
}

/* -------------------------------------------------------------- basics --- */

/** Open a repo, restoring a merge in progress from .git/MERGE_HEAD if there is one. */
export async function openRepo(dir) {
  const resolved = repoState.open(dir);
  await loadMergeState(resolved);
  return resolved;
}

const CLONE_BASE = path.join(os.homedir(), 'git-nd-repos');

/**
 * Absolute folder a clone will land in. The UI previews it with this same
 * function, so what the user sees is exactly where the clone goes.
 * - empty target    → ~/git-nd-repos/<repo name from the URL>
 * - "~" or "~/x"    → under the home directory
 * - relative target → under ~/git-nd-repos (NOT the server's working
 *                     directory, which is wherever `npm start` was run)
 */
export function cloneTarget(url, targetDir) {
  const raw = (targetDir || '').trim();
  if (!raw) {
    const name = (url || '').trim().replace(/\/+$/, '').split(/[/:]/).pop().replace(/\.git$/, '') || 'repo';
    return path.join(CLONE_BASE, name);
  }
  const expanded = raw === '~' || raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(1)) : raw;
  return path.resolve(CLONE_BASE, expanded);
}

/** Preview for the clone dialog: where it goes and whether that would fail. */
export function cloneTargetInfo(url, targetDir) {
  const dir = cloneTarget(url, targetDir);
  const notEmpty = fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
  return { dir, notEmpty };
}

export async function cloneRepo(url, targetDir, tokens) {
  const dir = cloneTarget(url, targetDir);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new AppError(`Target directory is not empty: ${dir}`, 400);
  }
  await fsp.mkdir(dir, { recursive: true });
  await git.clone({ fs, http, dir, url, onAuth: authFor(tokens), ...NO_REPO_PROXY });
  repoState.open(dir);
  return dir;
}

export async function currentBranch() {
  const dir = repoState.requireRepo();
  return (await git.currentBranch({ fs, dir, fullname: false })) || '(detached)';
}

export async function repoInfo() {
  const dir = repoState.requireRepo();
  // .git/MERGE_HEAD on disk is the source of truth, not the copy in memory:
  // a merge finished (or started) from a terminal must show here (BACKLOG B-06).
  await loadMergeState(dir);
  const [branch, remotes] = await Promise.all([
    currentBranch(),
    git.listRemotes({ fs, dir }).catch(() => []),
  ]);
  return {
    dir,
    name: path.basename(dir),
    branch,
    remotes,
    merge: repoState.merge
      ? { files: repoState.merge.files, resolved: repoState.merge.resolved, theirRef: repoState.merge.theirRef }
      : null,
  };
}

/* -------------------------------------------------------------- status --- */

const FILE = 0, HEAD = 1, WORKDIR = 2, STAGE = 3;

export async function status() {
  const dir = repoState.requireRepo();
  await loadMergeState(dir); // MERGE_HEAD is the source of truth (B-06)
  const matrix = await git.statusMatrix({ fs, dir, cache: repoState.gitCache() });
  const files = [];
  for (const row of matrix) {
    const [filepath, head, workdir, stage] = [row[FILE], row[HEAD], row[WORKDIR], row[STAGE]];
    if (head === 1 && workdir === 1 && stage === 1) continue; // unmodified

    let workStatus = null;
    let stageStatus = null;

    if (head === 0 && workdir === 2 && stage === 0) workStatus = 'untracked';
    else {
      if (head === 0 && stage >= 2) stageStatus = 'added';
      else if (head === 1 && stage === 0) stageStatus = 'deleted';
      else if (head === 1 && stage >= 2) stageStatus = 'modified';

      if (workdir === 0 && stage !== 0) workStatus = 'deleted';
      else if (workdir === 2 && stage === 3) workStatus = 'modified';
      else if (workdir === 2 && stage === 1) workStatus = 'modified';
      else if (workdir === 2 && stage === 0 && head === 1) workStatus = 'untracked';
    }

    const conflicted = repoState.merge?.files.includes(filepath) &&
      !repoState.merge?.resolved.includes(filepath);
    files.push({ filepath, workStatus, stageStatus, conflicted: !!conflicted });
  }
  return {
    branch: await currentBranch(),
    merge: repoState.merge ? { theirRef: repoState.merge.theirRef } : null,
    files,
  };
}

export async function stage(filepath) {
  const dir = repoState.requireRepo();
  await loadMergeState(dir); // MERGE_HEAD is the source of truth (B-06)
  const rel = repoState.relPath(filepath);
  const abs = repoState.safePath(filepath);
  if (fs.existsSync(abs)) {
    await git.add({ fs, dir, filepath: rel });
  } else {
    await git.remove({ fs, dir, filepath: rel });
  }
  if (repoState.merge && repoState.merge.files.includes(rel) &&
      !repoState.merge.resolved.includes(rel)) {
    repoState.merge.resolved.push(rel);
  }
}

export async function unstage(filepath) {
  const dir = repoState.requireRepo();
  await git.resetIndex({ fs, dir, filepath: repoState.relPath(filepath) });
}

/** The index entry for one path ({ oid, mode }), or null if it is not in the index. */
async function indexEntry(dir, rel) {
  const found = await git.walk({
    fs, dir, cache: repoState.gitCache(), trees: [git.STAGE()],
    map: async (filepath, [entry]) => {
      if (filepath === rel) return entry && { oid: await entry.oid(), mode: await entry.mode() };
      // Prune: only descend into directories on the way to `rel`.
      if (filepath !== '.' && !rel.startsWith(`${filepath}/`)) return null;
      return undefined;
    },
  });
  return found.find(Boolean) || null;
}

/**
 * Discard UNSTAGED changes: restore the file from the index, like
 * `git restore <file>`. Restoring from HEAD (as before) also wiped what was
 * staged, and deleted new staged files outright (BACKLOG B-03).
 * Untracked files (not in the index) are deleted.
 */
export async function discard(filepath) {
  const dir = repoState.requireRepo();
  const rel = repoState.relPath(filepath);
  const abs = repoState.safePath(filepath);
  const entry = await indexEntry(dir, rel);
  await fsp.rm(abs, { force: true });
  if (!entry) return; // untracked: nothing to restore
  const { blob } = await git.readBlob({ fs, dir, oid: entry.oid, cache: repoState.gitCache() });
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  if (entry.mode === 0o120000) {
    await fsp.symlink(Buffer.from(blob).toString('utf8'), abs);
  } else {
    await fsp.writeFile(abs, blob);
    await fsp.chmod(abs, entry.mode === 0o100755 ? 0o755 : 0o644);
  }
}

/* -------------------------------------------------------------- commit --- */

/** The connected account of the provider this repo's origin points at. */
async function providerAuthor(dir) {
  try {
    const remotes = await git.listRemotes({ fs, dir });
    const url = remotes.find((r) => r.remote === 'origin')?.url || '';
    const provider = url.includes('gitlab') ? 'gitlab' : url.includes('github') ? 'github' : null;
    if (!provider) return null;
    const user = tokenStore.user(provider);
    if (!user?.email) return null;
    return { name: user.name || user.login, email: user.email, source: provider };
  } catch {
    return null;
  }
}

/**
 * Author resolution, mirroring git's local-over-global semantics:
 * explicit → repo .git/config → connected provider account (by origin)
 * → app-wide default → error.
 */
async function resolveAuthor(dir, author) {
  if (author?.name && author?.email) return author;
  const name = await git.getConfig({ fs, dir, path: 'user.name' });
  const email = await git.getConfig({ fs, dir, path: 'user.email' });
  if (name && email) return { name, email };
  const fromProvider = await providerAuthor(dir);
  if (fromProvider) return fromProvider;
  const fallback = getSettings().defaultAuthor;
  if (fallback?.name && fallback?.email) return fallback;
  throw new AppError('Commit author not set: type it in the author field as "Name <email>"', 400);
}

export async function commit({ message, author }) {
  const dir = repoState.requireRepo();
  await loadMergeState(dir); // MERGE_HEAD is the source of truth (B-06)
  // Merge commits have a sensible default message ("Merge <ref>").
  if (!message?.trim() && !repoState.merge) throw new AppError('Commit message is required', 400);
  const who = await resolveAuthor(dir, author);
  if (author?.name && author?.email) {
    // Persist per repo (.git/config). The app-wide default is only seeded
    // once — a work identity in one repo must not clobber it.
    await setAuthor(author);
    if (!getSettings().defaultAuthor) {
      saveSettings({ defaultAuthor: { name: author.name, email: author.email } });
    }
  }

  if (repoState.merge) {
    return completeMerge({ message, author: who });
  }
  // A commit snapshots the index; an empty index would produce an empty commit.
  const matrix = await git.statusMatrix({ fs, dir, cache: repoState.gitCache() });
  const hasStaged = matrix.some(([, head, , stage]) =>
    (head === 0 && stage >= 2) || (head === 1 && stage !== 1));
  if (!hasStaged) throw new AppError('Nothing staged to commit: stage some changes first', 400);
  const oid = await git.commit({ fs, dir, message, author: who });
  return { oid };
}

export async function stageAll() {
  const { files } = await status();
  for (const f of files) {
    if (f.workStatus || f.conflicted) await stage(f.filepath);
  }
}

export async function unstageAll() {
  const { files } = await status();
  for (const f of files) {
    if (f.stageStatus) await unstage(f.filepath);
  }
}

export async function setAuthor({ name, email }) {
  const dir = repoState.requireRepo();
  await git.setConfig({ fs, dir, path: 'user.name', value: name });
  await git.setConfig({ fs, dir, path: 'user.email', value: email });
}

export async function getAuthor() {
  const dir = repoState.requireRepo();
  const name = await git.getConfig({ fs, dir, path: 'user.name' });
  const email = await git.getConfig({ fs, dir, path: 'user.email' });
  if (name && email) return { name, email, source: 'repo' };
  const fromProvider = await providerAuthor(dir);
  if (fromProvider) return fromProvider;
  const fallback = getSettings().defaultAuthor;
  if (fallback?.name) return { ...fallback, source: 'default' };
  return { name: '', email: '', source: 'none' };
}

/* ------------------------------------------------------------- history --- */

const mapCommit = (c) => ({
  oid: c.oid,
  message: c.commit.message.trim(),
  author: c.commit.author.name,
  email: c.commit.author.email,
  date: c.commit.author.timestamp * 1000,
  // Ordering uses the committer date, like git: author dates survive rebases
  // and cherry-picks, so a parent is often "newer" than its child by author
  // date (113 such edges on a 14k-commit repo vs 3 by committer date).
  committedAt: c.commit.committer.timestamp * 1000,
  parents: c.commit.parent,
});

export async function history({ depth = 100, ref } = {}) {
  const dir = repoState.requireRepo();
  if (!ref && !(await hasCommits(dir))) return []; // new repo: empty history, not an error (BACKLOG B-08)
  const commits = await git.log({ fs, dir, depth: Number(depth), ref: ref || undefined, cache: repoState.gitCache() });
  return commits.map(mapCommit);
}

/** False for a freshly initialized repo, whose HEAD points at a branch with no commits yet. */
async function hasCommits(dir) {
  try {
    await git.resolveRef({ fs, dir, ref: 'HEAD' });
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------- graph --- */

const GRAPH_MAX_LIMIT = 20000; // one request may re-load what the user already scrolled through

/**
 * Branch tips (local + origin) and HEAD, plus `walkId`: a hash of every
 * ref → oid. Same refs ⇒ same walk ⇒ same rows, so the id tells the client
 * whether its pages are still valid. Resolving 259 refs takes ~0.16 s.
 */
async function graphRefs(dir) {
  const { current, local, remote } = await listBranches();
  const tips = {}; // oid → [{ name, remote, current }]
  const pairs = [];
  for (const name of [...local, ...remote]) {
    try {
      const oid = await git.resolveRef({ fs, dir, ref: name });
      (tips[oid] ||= []).push({ name, remote: name.includes('/'), current: name === current });
      pairs.push(`${name}=${oid}`);
    } catch { /* dangling ref */ }
  }
  let headOid = null;
  try { headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' }); } catch { /* empty repo */ }
  pairs.sort();
  const walkId = createHash('sha1').update(`HEAD=${headOid}\n${pairs.join('\n')}`).digest('hex').slice(0, 16);
  return { walkId, tips, headOid, current };
}

/**
 * One page of the graph (docs/adr/0001): commits + branch tips; tags come
 * from graphTags() afterwards.
 * - `known`: the client's walkId; if refs did not change → `{ unchanged }`.
 * - `walk`:  the walkId the client is paging; if refs changed since → 409,
 *            and the client reloads from offset 0.
 */
export async function graphPage({ walk, known, offset = 0, limit = 200 } = {}) {
  const dir = repoState.requireRepo();
  const refs = await graphRefs(dir);
  if (known && known === refs.walkId) return { walkId: refs.walkId, unchanged: true };
  if (walk && walk !== refs.walkId) {
    throw new AppError('Branches changed since this page was loaded: reload the graph', 409);
  }
  const from = Math.max(0, Number(offset) || 0);
  const count = Math.min(GRAPH_MAX_LIMIT, Math.max(1, Number(limit) || 200));

  let gw = repoState.graphWalk;
  if (!gw || gw.id !== refs.walkId) {
    const seeds = Object.keys(refs.tips);
    if (refs.headOid && !refs.tips[refs.headOid]) seeds.push(refs.headOid); // detached HEAD
    gw = repoState.graphWalk = {
      id: refs.walkId,
      walk: new GraphWalk({ dir, getCache: () => repoState.gitCache(), tips: seeds }),
    };
  }
  await gw.walk.ensure(from + count);
  const emitted = gw.walk.emitted;
  return {
    walkId: refs.walkId,
    offset: from,
    commits: emitted.slice(from, from + count).map(mapCommit),
    tips: refs.tips,
    headOid: refs.headOid,
    current: refs.current,
    done: gw.walk.done && from + count >= emitted.length,
  };
}

/** Tags for the graph, `{ oid: [name] }`. Requested after the first page. */
export async function graphTags() {
  const tags = {};
  for (const t of await listTagsDetailed()) (tags[t.oid] ||= []).push(t.name);
  return { tags };
}

/** Files touched by a commit (vs its first parent), for the detail view. */
export async function commitDetail(oid) {
  const dir = repoState.requireRepo();
  const c = await git.readCommit({ fs, dir, oid, cache: repoState.gitCache() });
  const parent = c.commit.parent[0] || null;
  let files;
  if (parent) {
    files = await changedFiles(dir, parent, oid);
  } else {
    // Root commit: everything in its tree is an addition.
    const entries = await git.walk({
      fs, dir, trees: [git.TREE({ ref: oid })],
      map: async (filepath, [a]) => {
        if (filepath === '.' || (await a.type()) === 'tree') return undefined;
        return { filepath, type: 'add' };
      },
    });
    files = entries.flat(Infinity).filter(Boolean);
  }
  return { ...mapCommit(c), files };
}

async function requireCleanTree(dir) {
  const matrix = await git.statusMatrix({ fs, dir, cache: repoState.gitCache() });
  if (matrix.some(([, h, w, s]) => !(h === 1 && w === 1 && s === 1))) {
    throw new AppError('Working tree has local changes: commit or stash them first', 409);
  }
}

/**
 * Write `targetOid`'s version of each file, but only if the current content
 * still equals `guardOid`'s version — otherwise a later commit touched it and
 * we abort instead of guessing (same conservative policy as the rebase).
 */
async function applyDelta(dir, files, targetOid, guardOid, headOid) {
  for (const { filepath } of files) {
    const [guardBlob, currentBlob, targetBlob] = await Promise.all([
      readBlobAt(dir, guardOid, filepath),
      readBlobAt(dir, headOid, filepath),
      readBlobAt(dir, targetOid, filepath),
    ]);
    if (!bufEq(currentBlob, guardBlob)) {
      throw new AppError(`Conflict in ${filepath}: it changed after that commit. Resolve manually.`, 409);
    }
    const abs = path.join(dir, filepath);
    if (targetBlob === null) {
      await fsp.rm(abs, { force: true });
      await git.remove({ fs, dir, filepath });
    } else {
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, targetBlob);
      await git.add({ fs, dir, filepath });
    }
  }
}

async function replayCommitOp(oid, author, mode) {
  const dir = repoState.requireRepo();
  if (await loadMergeState(dir)) throw new AppError('A merge is in progress: resolve or abort it first', 409);
  oid = await git.expandOid({ fs, dir, oid }); // accept short hashes too
  await requireCleanTree(dir);
  const branch = await git.currentBranch({ fs, dir, fullname: false });
  if (!branch) throw new AppError('Detached HEAD: check out a branch first', 400);

  const c = await git.readCommit({ fs, dir, oid, cache: repoState.gitCache() });
  if (c.commit.parent.length > 1) throw new AppError(`Cannot ${mode} a merge commit`, 409);
  const parent = c.commit.parent[0];
  if (!parent) throw new AppError(`Cannot ${mode} the root commit`, 409);

  const files = await changedFiles(dir, parent, oid);
  const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  try {
    if (mode === 'revert') {
      await applyDelta(dir, files, parent, oid, headOid);
      const subject = c.commit.message.split('\n')[0];
      const who = await resolveAuthor(dir, author);
      return {
        oid: await git.commit({
          fs, dir, author: who,
          message: `Revert "${subject}"\n\nThis reverts commit ${oid}.`,
        }),
      };
    }
    // cherry-pick: keep the original author, current user becomes committer.
    await applyDelta(dir, files, oid, parent, headOid);
    const who = await resolveAuthor(dir, author);
    return {
      oid: await git.commit({
        fs, dir,
        message: c.commit.message,
        author: { name: c.commit.author.name, email: c.commit.author.email },
        committer: who,
      }),
    };
  } catch (err) {
    await git.checkout({ fs, dir, ref: branch, force: true }); // restore, tree was clean
    throw err;
  }
}

export const revertCommit = (oid, author) => replayCommitOp(oid, author, 'revert');
export const cherryPick = (oid, author) => replayCommitOp(oid, author, 'cherry-pick');

/** Rewrite the branch tip: same parents, current index, new/old message. */
export async function amendCommit({ message, author }) {
  const dir = repoState.requireRepo();
  if (await loadMergeState(dir)) throw new AppError('Cannot amend during a merge', 409);
  const branch = await git.currentBranch({ fs, dir, fullname: false });
  if (!branch) throw new AppError('Detached HEAD: cannot amend', 400);
  const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  const head = await git.readCommit({ fs, dir, oid: headOid, cache: repoState.gitCache() });
  const who = await resolveAuthor(dir, author);
  const oid = await git.commit({
    fs, dir,
    message: message?.trim() || head.commit.message,
    parent: head.commit.parent,
    author: { name: head.commit.author.name, email: head.commit.author.email }, // keep original author
    committer: who,
  });
  return { oid, amended: headOid };
}

/* ----------------------------------------------------------------- tags --- */

/**
 * Every tag with the commit it points to. Sequential on purpose: a Promise.all
 * over 1,035 tags overflowed isomorphic-git's lock queue (max 1,000 pending)
 * and the in-flight reads then exhausted the heap. With the shared cache the
 * sequential loop takes ~0.8 s on that repo.
 */
export async function listTagsDetailed() {
  const dir = repoState.requireRepo();
  const cache = repoState.gitCache();
  const names = await git.listTags({ fs, dir });
  const tags = [];
  for (const name of names) {
    let oid = await git.resolveRef({ fs, dir, ref: `refs/tags/${name}` });
    try {
      const t = await git.readTag({ fs, dir, oid, cache });
      oid = t.tag.object; // annotated tag → the commit it points to
    } catch { /* lightweight tag: already a commit oid */ }
    tags.push({ name, oid });
  }
  return tags;
}

export async function createTag(name, oid) {
  const dir = repoState.requireRepo();
  if (!/^[\w.\-/]+$/.test(name || '')) throw new AppError('Invalid tag name', 400);
  await git.tag({ fs, dir, ref: name, object: oid || undefined });
}

export async function deleteTag(name) {
  const dir = repoState.requireRepo();
  await git.deleteTag({ fs, dir, ref: name });
}

export async function pushTag(name, tokens) {
  const dir = repoState.requireRepo();
  await remoteUrl(dir, 'origin'); // clear error if there is no origin
  await git.push({
    fs, http, dir, remote: 'origin',
    ref: `refs/tags/${name}`, remoteRef: `refs/tags/${name}`,
    onAuth: authFor(tokens), ...NO_REPO_PROXY,
  });
}

export async function resetToCommit(oid) {
  const dir = repoState.requireRepo();
  const branch = await git.currentBranch({ fs, dir, fullname: false });
  if (!branch) throw new AppError('Detached HEAD: cannot reset', 400);
  await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
  await git.checkout({ fs, dir, ref: branch, force: true });
  await clearMergeState(dir); // a reset ends any merge in progress, as in git
  return { branch, oid };
}

/* ------------------------------------------------------------ branches --- */

export async function listBranches() {
  const dir = repoState.requireRepo();
  const [local, current] = await Promise.all([
    git.listBranches({ fs, dir }),
    currentBranch(),
  ]);
  let remote = [];
  try {
    remote = (await git.listBranches({ fs, dir, remote: 'origin' }))
      .filter((b) => b !== 'HEAD')
      .map((b) => `origin/${b}`);
  } catch { /* no origin */ }
  return { current, local, remote };
}

export async function createBranch(name, checkout = true) {
  const dir = repoState.requireRepo();
  await git.branch({ fs, dir, ref: name, checkout });
}

export async function switchBranch(name) {
  const dir = repoState.requireRepo();
  if (await loadMergeState(dir)) throw new AppError('A merge is in progress: resolve or abort it first', 409);

  // Checking out a remote branch (origin/x) creates/uses the local branch "x".
  const prefix = name.split('/')[0];
  const remotes = await git.listRemotes({ fs, dir }).catch(() => []);
  if (name.includes('/') && remotes.some((r) => r.remote === prefix)) {
    const local = name.slice(prefix.length + 1);
    const locals = await git.listBranches({ fs, dir });
    let created = false;
    if (!locals.includes(local)) {
      const oid = await git.resolveRef({ fs, dir, ref: name });
      await git.writeRef({ fs, dir, ref: `refs/heads/${local}`, value: oid, force: false });
      created = true;
    }
    await git.checkout({ fs, dir, ref: local });
    return { branch: local, created, tracking: name };
  }

  await git.checkout({ fs, dir, ref: name });
  return { branch: name };
}

export async function deleteBranch(name) {
  const dir = repoState.requireRepo();
  const current = await currentBranch();
  if (name === current) throw new AppError('Cannot delete the current branch', 400);
  await git.deleteBranch({ fs, dir, ref: name });
}

/* ----------------------------------------------------------- push/pull --- */

export async function push({ remote = 'origin', tokens }) {
  const dir = repoState.requireRepo();
  const branch = await currentBranch();
  await remoteUrl(dir, remote); // clear error if the remote does not exist
  const res = await git.push({
    fs, http, dir, remote, ref: branch, onAuth: authFor(tokens), ...NO_REPO_PROXY,
  });
  if (res.error) throw new AppError(`Push rejected: ${res.error}`, 422);
  return { branch, remote };
}

/**
 * How far the local branch is from origin/<branch>.
 * With doFetch=true it hits the network first, so "behind" is fresh.
 */
export async function syncStatus({ tokens, doFetch = false } = {}) {
  const dir = repoState.requireRepo();
  const branch = await currentBranch();
  const remotes = await git.listRemotes({ fs, dir }).catch(() => []);
  const origin = remotes.find((r) => r.remote === 'origin');
  if (!origin || branch === '(detached)') return { branch, hasUpstream: false, ahead: 0, behind: 0 };

  if (doFetch) {
    await fetchRemote(dir, 'origin', origin.url, tokens, branch);
  }
  const theirRef = `origin/${branch}`;
  let remoteOid;
  try { remoteOid = await git.resolveRef({ fs, dir, ref: theirRef }); }
  catch { return { branch, hasUpstream: false, ahead: 0, behind: 0 }; }

  const localOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  if (localOid === remoteOid) return { branch, hasUpstream: true, ahead: 0, behind: 0 };

  const { left, right, truncated } = await partitionReachable({
    dir, cache: repoState.gitCache(), left: localOid, right: remoteOid,
  });
  return { branch, hasUpstream: true, ahead: left.length, behind: right.length, truncated };
}

/* ------------------------------------------------- merge state on disk --- */
/*
 * A merge in progress is stored the way git stores it (BACKLOG B-06):
 * .git/MERGE_HEAD holds the incoming oid, .git/MERGE_MSG the message plus a
 * "# Conflicts:" list. It survives reopening the repo or restarting the
 * server, and a merge started with the git CLI is picked up too. "Resolved"
 * is not stored: it is derived from the index (see isResolved).
 */

const mergePath = (dir, name) => path.join(dir, '.git', name);
const MERGE_FILES = ['MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE'];

async function writeMergeState(dir, { theirRef, theirOid, files }) {
  const conflicts = files.length ? `\n# Conflicts:\n${files.map((f) => `#\t${f}`).join('\n')}\n` : '';
  await fsp.writeFile(mergePath(dir, 'MERGE_HEAD'), `${theirOid}\n`);
  await fsp.writeFile(mergePath(dir, 'MERGE_MSG'), `Merge ${theirRef}\n${conflicts}`);
}

async function clearMergeState(dir) {
  for (const f of MERGE_FILES) await fsp.rm(mergePath(dir, f), { force: true });
  repoState.merge = null;
}

/** Staged, identical to the working file, and free of conflict markers. */
async function isResolved(dir, rel) {
  const entry = await indexEntry(dir, rel);
  const abs = path.join(dir, rel);
  if (!entry) return !fs.existsSync(abs); // resolved by deleting the file
  if (!fs.existsSync(abs)) return false;
  const { blob } = await git.readBlob({ fs, dir, oid: entry.oid, cache: repoState.gitCache() });
  const staged = Buffer.from(blob);
  if (!staged.equals(await fsp.readFile(abs))) return false;
  return !/^(<{7}|>{7})( |$)/m.test(staged.toString('utf8'));
}

/** Rebuild repoState.merge from .git/MERGE_HEAD (null when no merge is in progress). */
export async function loadMergeState(dir) {
  let theirOid;
  try {
    theirOid = (await fsp.readFile(mergePath(dir, 'MERGE_HEAD'), 'utf8')).trim().split('\n')[0];
  } catch {
    repoState.merge = null;
    return null;
  }
  const msg = await fsp.readFile(mergePath(dir, 'MERGE_MSG'), 'utf8').catch(() => '');
  // Ours: "Merge feat". git CLI: "Merge branch 'feat'" / "Merge remote-tracking branch 'origin/x'".
  const theirRef = msg.match(/^Merge (?:remote-tracking )?(?:branch )?'?([^'\n]+?)'?(?: into .*)?$/m)?.[1] || theirOid.slice(0, 7);
  const section = msg.split(/^# Conflicts:$/m)[1] || '';
  const files = [...section.matchAll(/^#\t(.+)$/gm)].map((m) => m[1]);
  const resolved = [];
  for (const f of files) if (await isResolved(dir, f)) resolved.push(f);
  repoState.merge = { theirRef, theirOid, files, resolved };
  return repoState.merge;
}

/**
 * A merge ends with a forced checkout of the result, which overwrites the
 * working tree (BACKLOG B-02). So, before touching anything:
 * - any change to a tracked file (staged or not) blocks the merge;
 * - an untracked file blocks it only if the merge brings a file at that path.
 * Unrelated untracked files are left alone, as git does.
 */
async function requireMergeableTree(dir, theirOid) {
  const matrix = await git.statusMatrix({ fs, dir, cache: repoState.gitCache() });
  const isUntracked = ([, h, , s]) => h === 0 && s === 0;
  const changed = matrix.filter((r) => !isUntracked(r) && !(r[1] === 1 && r[2] === 1 && r[3] === 1)).map((r) => r[0]);
  if (changed.length) {
    throw new AppError(`Uncommitted changes would be lost by the merge (${changed.join(', ')}): commit or stash them first`, 409);
  }
  const untracked = new Set(matrix.filter(isUntracked).map((r) => r[0]));
  if (!untracked.size) return;
  const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  const clashes = (await changedFiles(dir, headOid, theirOid)).map((f) => f.filepath).filter((p) => untracked.has(p));
  if (clashes.length) {
    throw new AppError(`The merge would overwrite untracked files (${clashes.join(', ')}): move or commit them first`, 409);
  }
}

async function doMerge(theirRef, author) {
  const dir = repoState.requireRepo();
  const ours = await currentBranch();
  const theirOid = await git.resolveRef({ fs, dir, ref: theirRef });
  await requireMergeableTree(dir, theirOid);
  try {
    const result = await git.merge({
      fs, dir, ours, theirs: theirRef, abortOnConflict: false, author,
    });
    // merge writes the commit; refresh the working directory to match.
    await git.checkout({ fs, dir, ref: ours, force: true });
    return { ...result, conflicts: null };
  } catch (err) {
    if (err.code === 'MergeConflictError' || err.name === 'MergeConflictError') {
      const files = err.data?.filepaths || [];
      repoState.merge = { theirRef, theirOid, files, resolved: [] };
      await writeMergeState(dir, repoState.merge);
      // isomorphic-git writes merge results to the workdir but stages nothing.
      // Stage the auto-merged (non-conflicted) files like real git does, or
      // the final merge commit would silently drop them.
      const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
      const conflicted = new Set(files);
      for (const { filepath } of await changedFiles(dir, headOid, theirOid)) {
        if (conflicted.has(filepath)) continue;
        if (fs.existsSync(path.join(dir, filepath))) {
          await git.add({ fs, dir, filepath });
        } else {
          await git.remove({ fs, dir, filepath });
        }
      }
      return { conflicts: files };
    }
    throw err;
  }
}

export async function pull({ remote = 'origin', tokens, author, rebase = false }) {
  const dir = repoState.requireRepo();
  if (await loadMergeState(dir)) throw new AppError('A merge is in progress: resolve or abort it first', 409);
  const branch = await currentBranch();
  const url = await remoteUrl(dir, remote);
  const who = await resolveAuthor(dir, author);
  await fetchRemote(dir, remote, url, tokens, branch);
  const theirRef = `${remote}/${branch}`;
  try {
    await git.resolveRef({ fs, dir, ref: theirRef });
  } catch {
    return { branch, upToDate: true, note: 'Branch does not exist on the remote yet' };
  }
  if (rebase) {
    const result = await rebaseOnto(branch, theirRef);
    return { branch, ...result };
  }
  const result = await doMerge(theirRef, who);
  return { branch, ...result };
}

/* ------------------------------------------------------------- rebase --- */

async function readBlobAt(dir, oid, filepath) {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath });
    return Buffer.from(blob);
  } catch {
    return null; // file does not exist at that commit
  }
}

const bufEq = (a, b) => (a === null && b === null) || (a !== null && b !== null && a.equals(b));

/** Files whose blob differs between two commits. */
async function changedFiles(dir, oidA, oidB) {
  const entries = await git.walk({
    fs, dir,
    trees: [git.TREE({ ref: oidA }), git.TREE({ ref: oidB })],
    map: async (filepath, [a, b]) => {
      if (filepath === '.') return undefined;
      const [at, bt] = [a && await a.type(), b && await b.type()];
      if (at === 'tree' || bt === 'tree') return undefined;
      const [ao, bo] = [a && await a.oid(), b && await b.oid()];
      if (ao === bo) return undefined;
      return { filepath, type: !ao ? 'add' : !bo ? 'del' : 'mod' };
    },
  });
  return entries.flat(Infinity).filter(Boolean);
}

/**
 * Pull --rebase: replay local commits on top of the fetched remote tip.
 * Conflict policy is file-level and conservative: if the remote touched a
 * file one of our commits also touched, abort cleanly (branch restored)
 * and suggest a merge pull. Real git is line-level; this keeps the common
 * "we worked on different files" case linear without risking history.
 */
async function rebaseOnto(branch, theirRef) {
  const dir = repoState.requireRepo();

  const matrix = await git.statusMatrix({ fs, dir, cache: repoState.gitCache() });
  const dirty = matrix.some(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
  if (dirty) throw new AppError('Working tree has local changes: commit or stash them before rebasing', 409);

  const remoteOid = await git.resolveRef({ fs, dir, ref: theirRef });
  const localOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  if (localOid === remoteOid) return { upToDate: true };

  // Exact split, however far apart the branches are (a fixed 300-commit
  // window missed the fast-forward when the branch was further behind).
  const { left: localOnly, right: remoteOnly, truncated } = await partitionReachable({
    dir, cache: repoState.gitCache(), left: localOid, right: remoteOid,
  });
  if (truncated) {
    throw new AppError('Branches diverged too far to rebase safely: use Pull (merge) instead', 409);
  }

  if (localOnly.length === 0) { // no local commits → fast-forward
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
    await git.checkout({ fs, dir, ref: branch, force: true });
    return { rebased: true, fastForward: true };
  }
  if (remoteOnly.length === 0) {
    return { upToDate: true, note: 'You are ahead of the remote; nothing to rebase' };
  }

  const toReplay = localOnly; // newest first, like git.log
  if (toReplay.some((c) => c.commit.parent.length > 1)) {
    throw new AppError('Cannot rebase merge commits: use Pull (merge) instead', 409);
  }
  toReplay.reverse(); // oldest first

  await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
  await git.checkout({ fs, dir, ref: branch, force: true });
  try {
    for (const c of toReplay) {
      const parent = c.commit.parent[0];
      for (const { filepath } of await changedFiles(dir, parent, c.oid)) {
        const [pBlob, cBlob] = await Promise.all([
          readBlobAt(dir, parent, filepath),
          readBlobAt(dir, c.oid, filepath),
        ]);
        const abs = path.join(dir, filepath);
        const current = fs.existsSync(abs) ? await fsp.readFile(abs) : null;
        if (bufEq(current, cBlob)) continue; // already applied
        if (!bufEq(current, pBlob)) {
          throw new AppError(
            `Rebase conflict in ${filepath}: the remote also changed it. Use Pull (merge) to resolve conflicts.`, 409);
        }
        if (cBlob === null) {
          await fsp.rm(abs, { force: true });
          await git.remove({ fs, dir, filepath });
        } else {
          await fsp.mkdir(path.dirname(abs), { recursive: true });
          await fsp.writeFile(abs, cBlob);
          await git.add({ fs, dir, filepath });
        }
      }
      await git.commit({ fs, dir, message: c.commit.message, author: c.commit.author });
    }
  } catch (err) {
    // Restore the branch exactly as it was — a failed rebase must be invisible.
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: localOid, force: true });
    await git.checkout({ fs, dir, ref: branch, force: true });
    throw err;
  }
  return { rebased: true, replayed: toReplay.length };
}

export async function mergeBranch({ theirRef, author }) {
  const dir = repoState.requireRepo();
  if (await loadMergeState(dir)) throw new AppError('A merge is in progress: resolve or abort it first', 409);
  const who = await resolveAuthor(dir, author);
  return doMerge(theirRef, who);
}

/* ------------------------------------------------------------ conflicts --- */

/** What `head` would contribute on top of `base`: commits + changed files. */
export async function compareRefs(base, head) {
  const dir = repoState.requireRepo();
  if (!base || !head) throw new AppError('base and head refs are required', 400);
  const baseOid = await git.resolveRef({ fs, dir, ref: base });
  const headOid = await git.resolveRef({ fs, dir, ref: head });
  const { right: headOnly } = await partitionReachable({
    dir, cache: repoState.gitCache(), left: baseOid, right: headOid, limit: 1000,
  });
  const commits = headOnly.map(mapCommit);
  const files = baseOid === headOid ? [] : await changedFiles(dir, baseOid, headOid);
  return { base, head, baseOid, headOid, commits, files };
}

/** Full picture of the in-progress merge for the Merge view. */
export async function mergeDetail() {
  const dir = repoState.requireRepo();
  const m = await loadMergeState(dir); // MERGE_HEAD is the source of truth (B-06)
  if (!m) return { active: false };

  const ours = await currentBranch();
  const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  const { right: theirOnly } = await partitionReachable({
    dir, cache: repoState.gitCache(), left: headOid, right: m.theirOid, limit: 1000,
  });
  const incoming = theirOnly.map(mapCommit);

  const changed = await changedFiles(dir, headOid, m.theirOid);
  const conflictedSet = new Set(m.files);
  const files = [
    ...m.files.map((f) => ({ filepath: f, conflicted: true, resolved: m.resolved.includes(f) })),
    ...changed
      .filter((c) => !conflictedSet.has(c.filepath))
      .map((c) => ({ filepath: c.filepath, conflicted: false, type: c.type })),
  ];
  return {
    active: true,
    ours,
    theirs: m.theirRef,
    incoming,
    files,
    pending: m.files.filter((f) => !m.resolved.includes(f)).length,
    totalConflicts: m.files.length,
  };
}

/**
 * Save a conflict resolution and mark it resolved — only while a merge is in
 * progress and only for a file it left in conflict. A stale Conflict tab
 * (merge aborted, repo switched) used to write and stage its content into a
 * tree with no merge, partly undoing the abort (BACKLOG B-07).
 */
export async function resolveConflict(filepath, content) {
  const rel = repoState.relPath(filepath);
  const merge = await loadMergeState(repoState.requireRepo()); // MERGE_HEAD is the source of truth (B-06)
  if (!merge) throw new AppError('No merge in progress: nothing to resolve', 409);
  if (!merge.files.includes(rel)) throw new AppError(`${rel} is not in conflict in this merge`, 409);
  if (/^(<{7}|={7}|>{7})( |$)/m.test(content)) throw new AppError('There are still conflict markers left', 400);
  await writeFile(rel, content);
  await stage(rel);
  return { resolved: rel };
}

export async function completeMerge({ message, author }) {
  const dir = repoState.requireRepo();
  const merge = await loadMergeState(dir); // MERGE_HEAD is the source of truth (B-06)
  if (!merge) throw new AppError('No merge in progress', 400);
  const pending = merge.files.filter((f) => !merge.resolved.includes(f));
  if (pending.length > 0) {
    throw new AppError(`Still unresolved: ${pending.join(', ')}`, 409);
  }
  const who = await resolveAuthor(dir, author);
  const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  const oid = await git.commit({
    fs, dir,
    message: message || `Merge ${merge.theirRef}`,
    author: who,
    parent: [headOid, merge.theirOid],
  });
  await clearMergeState(dir);
  return { oid, merged: true };
}

export async function abortMerge() {
  const dir = repoState.requireRepo();
  // Re-read from disk first: aborting a merge that already ended (finished
  // from a terminal) force-checked-out and destroyed newer work (B-06).
  if (!(await loadMergeState(dir))) throw new AppError('No merge in progress', 400);
  const branch = await currentBranch();
  await git.checkout({ fs, dir, ref: branch, force: true });
  await clearMergeState(dir);
}

/* ---------------------------------------------------------------- diff --- */

/**
 * Blob bytes → text, keeping a UTF-8 BOM. TextDecoder strips it by default
 * while the working file is read with the BOM, so line 1 showed a phantom
 * change and staging dropped the BOM (BACKLOG B-05).
 */
const utf8KeepBom = new TextDecoder('utf-8', { ignoreBOM: true });
const decodeText = (bytes) => utf8KeepBom.decode(bytes);

async function headContent(dir, rel) {
  try {
    const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const { blob } = await git.readBlob({ fs, dir, oid: headOid, filepath: rel });
    return decodeText(blob);
  } catch {
    return ''; // new file
  }
}

const blobText = async (dir, oid, rel) => {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: rel });
    return decodeText(blob);
  } catch {
    return ''; // file absent at that commit
  }
};

/**
 * Without oid: HEAD vs working directory (uncommitted changes).
 * With oid: that commit vs its first parent (what the commit changed).
 * With oid + base: the file between two arbitrary refs (branch compare).
 */
export async function diffFile(filepath, oid, base) {
  const dir = repoState.requireRepo();
  const rel = repoState.relPath(filepath);

  if (oid && base) {
    const [oldText, newText] = await Promise.all([
      blobText(dir, base, rel),
      blobText(dir, oid, rel),
    ]);
    return { filepath: rel, oid, base, rows: sideBySideRows(oldText, newText) };
  }

  if (oid) {
    const c = await git.readCommit({ fs, dir, oid, cache: repoState.gitCache() });
    const parent = c.commit.parent[0] || null;
    const oldText = parent ? await blobText(dir, parent, rel) : '';
    const newText = await blobText(dir, oid, rel);
    return { filepath: rel, oid, rows: sideBySideRows(oldText, newText) };
  }

  const abs = repoState.safePath(filepath, { follow: true });
  const oldText = await headContent(dir, rel);
  const newText = fs.existsSync(abs) ? await fsp.readFile(abs, 'utf8') : '';
  return { filepath: rel, rows: sideBySideRows(oldText, newText) };
}

/** Turn a line diff into aligned rows for a side-by-side view. */
function sideBySideRows(oldText, newText) {
  const parts = Diff.diffLines(oldText, newText);
  const rows = [];
  let oldLn = 1, newLn = 1;
  let removedBuf = [];

  const flushRemoved = () => {
    for (const line of removedBuf) {
      rows.push({ left: { ln: oldLn++, text: line, type: 'removed' }, right: null });
    }
    removedBuf = [];
  };

  for (const part of parts) {
    const lines = part.value.split('\n');
    if (lines.at(-1) === '') lines.pop();

    if (part.removed) {
      removedBuf.push(...lines);
    } else if (part.added) {
      for (const line of lines) {
        if (removedBuf.length > 0) {
          rows.push({
            left: { ln: oldLn++, text: removedBuf.shift(), type: 'removed' },
            right: { ln: newLn++, text: line, type: 'added' },
          });
        } else {
          rows.push({ left: null, right: { ln: newLn++, text: line, type: 'added' } });
        }
      }
      flushRemoved();
    } else {
      flushRemoved();
      for (const line of lines) {
        rows.push({
          left: { ln: oldLn++, text: line, type: 'context' },
          right: { ln: newLn++, text: line, type: 'context' },
        });
      }
    }
  }
  flushRemoved();
  return rows;
}

/* --------------------------------------------------------- hunk staging --- */

/** Text of the file as currently staged (index), or null if not in the index. */
async function indexBlobText(dir, rel) {
  let oid = null;
  await git.walk({
    fs, dir, trees: [git.STAGE()],
    map: async (fp, [entry]) => {
      if (fp === rel && entry && (await entry.type()) === 'blob') {
        oid = await entry.oid();
      }
      return true;
    },
  });
  if (!oid) return null;
  const { blob } = await git.readBlob({ fs, dir, oid });
  return decodeText(blob);
}

const assertText = (text, rel) => {
  if (text.includes('\0')) throw new AppError(`${rel} is binary: stage the whole file instead`, 422);
};

/** Unified-diff hunk lines → aligned side-by-side rows with line numbers. */
function hunkRows(h) {
  let oldLn = h.oldStart;
  let newLn = h.newStart;
  const rows = [];
  let removed = [];
  const flush = () => {
    for (const text of removed) rows.push({ left: { ln: oldLn++, text, type: 'removed' }, right: null });
    removed = [];
  };
  for (const line of h.lines) {
    const tag = line[0];
    const text = line.slice(1);
    if (tag === '\\') continue; // "\ No newline at end of file": a marker, not a file line
    if (tag === '-') removed.push(text);
    else if (tag === '+') {
      if (removed.length) {
        rows.push({ left: { ln: oldLn++, text: removed.shift(), type: 'removed' }, right: { ln: newLn++, text, type: 'added' } });
      } else {
        rows.push({ left: null, right: { ln: newLn++, text, type: 'added' } });
      }
    } else {
      flush();
      rows.push({ left: { ln: oldLn++, text, type: 'context' }, right: { ln: newLn++, text, type: 'context' } });
    }
  }
  flush();
  return rows;
}

/** Split keeping each line's terminator: "a\nb" → ["a\n", "b"]; "a\n" → ["a\n"]. */
const splitKeepEol = (text) => text.match(/[^\n]*\n|[^\n]+$/g) || [];

/**
 * A hunk's lines as [tag, text-with-terminator]. jsdiff marks a line that
 * lacks a final "\n" with a following "\ No newline at end of file" entry;
 * that marker only strips the "\n" from the previous line (BACKLOG B-05 —
 * it used to be written into the file as text).
 */
function hunkLines(h, plusText) {
  const lines = [];
  for (const line of h.lines) {
    if (line[0] === '\\') {
      const last = lines[lines.length - 1];
      // jsdiff also emits the marker when the OTHER side is empty
      // ("a\nb\n" → "" marks "-b"), so trust it only when the side the line
      // comes from really ends without "\n". Only "+" lines matter: context
      // lines copy the file's own bytes and "-" lines are skipped.
      if (last && (last[0] !== '+' || !plusText.endsWith('\n'))) last[1] = last[1].replace(/\n$/, '');
    } else {
      lines.push([line[0], `${line.slice(1)}\n`]);
    }
  }
  return lines;
}

/**
 * Apply the selected hunks (by index) onto oldText; unselected hunks are
 * skipped. Byte-exact. `plusText` is the text the "+" lines come from.
 */
function applyHunks(oldText, hunks, selected, plusText) {
  const oldLines = splitKeepEol(oldText);
  const out = [];
  let cursor = 0;
  hunks.forEach((h, i) => {
    // Pure-insertion hunks (oldLines=0) anchor AFTER old line oldStart.
    const start = h.oldLines === 0 ? h.oldStart : h.oldStart - 1;
    out.push(...oldLines.slice(cursor, start));
    cursor = start;
    if (!selected.includes(i)) return; // leave the old content untouched
    for (const [tag, text] of hunkLines(h, plusText)) {
      if (tag === '+') out.push(text);
      else if (tag === '-') cursor++;
      else { out.push(oldLines[cursor]); cursor++; } // context: keep the file's own bytes
    }
  });
  out.push(...oldLines.slice(cursor));
  return out.join('');
}

const reverseHunk = (h) => ({
  oldStart: h.newStart, oldLines: h.newLines,
  newStart: h.oldStart, newLines: h.oldLines,
  lines: h.lines.map((l) => (l[0] === '+' ? `-${l.slice(1)}` : l[0] === '-' ? `+${l.slice(1)}` : l)),
});

/** old/new texts for a diff target: unstaged = index→workdir, staged = HEAD→index. */
async function hunkTexts(dir, rel, abs, target) {
  if (target === 'staged') {
    const oldText = await headContent(dir, rel);
    const newText = (await indexBlobText(dir, rel)) ?? '';
    return { oldText, newText };
  }
  const oldText = (await indexBlobText(dir, rel)) ?? '';
  const newText = fs.existsSync(abs) ? await fsp.readFile(abs, 'utf8') : '';
  return { oldText, newText };
}

function computeHunks(oldText, newText, rel) {
  assertText(oldText, rel);
  assertText(newText, rel);
  return Diff.structuredPatch(rel, rel, oldText, newText, '', '', { context: 3 }).hunks;
}

/**
 * Symlinks are versioned as their target PATH (mode 120000). Reading one for
 * hunks followed the link and compared the target's content with the link
 * blob, and staging a "hunk" replaced the link with that content (BACKLOG
 * B-20). Checked before any content is read: on disk and in the index.
 */
async function isSymlinkEntry(dir, rel, abs) {
  try {
    if (fs.lstatSync(abs).isSymbolicLink()) return true;
  } catch { /* not on disk */ }
  return (await indexEntry(dir, rel))?.mode === 0o120000;
}
const symlinkNoHunks = () => new AppError('Symbolic links have no hunks: stage or discard the whole entry', 400);

export async function fileHunks(filepath, target = 'unstaged') {
  const dir = repoState.requireRepo();
  const rel = repoState.relPath(filepath);
  if (await isSymlinkEntry(dir, rel, repoState.safePath(filepath))) {
    return { filepath: rel, target, hunks: [], symlink: true };
  }
  const abs = repoState.safePath(filepath, { follow: true });
  const { oldText, newText } = await hunkTexts(dir, rel, abs, target);
  const hunks = computeHunks(oldText, newText, rel);
  return {
    filepath: rel,
    target,
    hunks: hunks.map((h, i) => ({
      index: i,
      header: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      rows: hunkRows(h),
    })),
  };
}

/** Whether HEAD has a file at `rel` (false for new files and empty repos). */
async function inHead(dir, rel) {
  try {
    const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    await git.readBlob({ fs, dir, oid: headOid, filepath: rel });
    return true;
  } catch {
    return false;
  }
}

async function writeIndex(dir, rel, abs, text) {
  if (text === '' && !fs.existsSync(abs)) {
    await git.remove({ fs, dir, filepath: rel });
    return;
  }
  const oid = await git.writeBlob({ fs, dir, blob: new TextEncoder().encode(text) });
  // Keep the mode, as `git apply --cached` does: the index entry's if the file
  // is tracked, the working file's executable bit if it is new. Without it
  // updateIndex defaults to 100644 and scripts lost +x (BACKLOG B-11).
  const entry = await indexEntry(dir, rel);
  const executable = () => { try { return (fs.statSync(abs).mode & 0o111) !== 0; } catch { return false; } };
  const mode = entry?.mode ?? (executable() ? 0o100755 : 0o100644);
  await git.updateIndex({ fs, dir, filepath: rel, oid, add: true, mode });
}

/** op: stage (index += hunks), unstage (index -= hunks), discard (workdir -= hunks). */
export async function applyHunkOp(filepath, indexes, op) {
  const dir = repoState.requireRepo();
  const rel = repoState.relPath(filepath);
  if (await isSymlinkEntry(dir, rel, repoState.safePath(filepath))) throw symlinkNoHunks();
  const abs = repoState.safePath(filepath, { follow: true });
  const selected = (indexes || []).map(Number);
  if (selected.length === 0) throw new AppError('No hunks selected', 400);

  if (op === 'stage') {
    const { oldText, newText } = await hunkTexts(dir, rel, abs, 'unstaged');
    const hunks = computeHunks(oldText, newText, rel);
    await writeIndex(dir, rel, abs, applyHunks(oldText, hunks, selected, newText));
  } else if (op === 'unstage') {
    const { oldText, newText } = await hunkTexts(dir, rel, abs, 'staged');
    const reversed = computeHunks(oldText, newText, rel).map(reverseHunk);
    const text = applyHunks(newText, reversed, selected, oldText);
    if (text === '' && !(await inHead(dir, rel))) {
      // Every hunk of a NEW file unstaged: drop the entry, like `git restore --staged`,
      // instead of leaving an empty blob staged (BACKLOG B-05).
      await git.resetIndex({ fs, dir, filepath: rel });
    } else {
      await writeIndex(dir, rel, abs, text);
    }
  } else if (op === 'discard') {
    const { oldText, newText } = await hunkTexts(dir, rel, abs, 'unstaged');
    const reversed = computeHunks(oldText, newText, rel).map(reverseHunk);
    await fsp.writeFile(abs, applyHunks(newText, reversed, selected, oldText), 'utf8');
  } else {
    throw new AppError(`Unknown hunk operation: ${op}`, 400);
  }
}

/* ---------------------------------------------------------------- stash --- */

export async function stash(op, message) {
  const dir = repoState.requireRepo();
  const result = await git.stash({ fs, dir, op, message });
  return result ?? null;
}

/* ----------------------------------------------------------- tree/files --- */

export async function tree(dirPath = '.') {
  const abs = repoState.safePath(dirPath, { follow: true });
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  return entries
    .filter((e) => !IGNORED_DIRS.has(e.name))
    .map((e) => ({
      name: e.name,
      path: path.posix.join(dirPath === '.' ? '' : dirPath, e.name),
      type: e.isDirectory() ? 'dir' : 'file',
    }))
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
}

export async function flatFileList(limit = 5000) {
  const root = repoState.requireRepo();
  const out = [];
  const skip = new Set(['.git', 'node_modules', '.next', 'dist', 'build']);
  const walk = async (rel) => {
    if (out.length >= limit) return;
    const entries = await fsp.readdir(path.join(root, rel), { withFileTypes: true });
    for (const e of entries) {
      if (out.length >= limit) return;
      if (skip.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(childRel);
      else out.push(childRel);
    }
  };
  await walk('');
  return out;
}

export async function readFile(filepath) {
  const abs = repoState.safePath(filepath, { follow: true });
  const stat = await fsp.stat(abs);
  if (stat.size > 2 * 1024 * 1024) throw new AppError('File too large to display', 413);
  const buf = await fsp.readFile(abs);
  const isBinary = buf.subarray(0, 8000).includes(0);
  return { filepath, binary: isBinary, content: isBinary ? null : buf.toString('utf8'), size: stat.size };
}

export async function writeFile(filepath, content) {
  const abs = repoState.safePath(filepath, { follow: true });
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
}

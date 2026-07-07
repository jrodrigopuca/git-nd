import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import * as Diff from 'diff';
import { repoState, AppError } from './state.js';
import { getSettings, saveSettings } from './settings.js';
import { tokenStore } from './tokenStore.js';

const IGNORED_DIRS = new Set(['.git']);

/* ---------------------------------------------------------------- auth --- */

/**
 * Build the onAuth callback for push/pull/clone based on the remote URL host
 * and the tokens stored in the user session (OAuth or PAT).
 */
function authFor(url, tokens = {}) {
  return () => {
    let host = '';
    try { host = new URL(url).host; } catch { /* ssh urls etc. */ }
    if (host.includes('gitlab')) {
      const token = tokens.gitlab;
      if (token) return { username: 'oauth2', password: token };
    }
    const token = tokens.github || tokens.gitlab;
    if (token) return { username: token, password: 'x-oauth-basic' };
    return { cancel: true };
  };
}

/** Fetch all branches; if the remote HEAD dangles, fall back to just ours. */
async function fetchRemote(dir, remote, url, tokens, branch) {
  const onAuth = authFor(url, tokens);
  try {
    await git.fetch({ fs, http, dir, remote, onAuth });
  } catch (err) {
    if (err.code === 'NotFoundError' && branch) {
      await git.fetch({ fs, http, dir, remote, onAuth, ref: branch, singleBranch: true });
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

export function openRepo(dir) {
  return repoState.open(dir);
}

export async function cloneRepo(url, targetDir, tokens) {
  let dir = targetDir;
  if (!dir) {
    const name = url.split('/').pop().replace(/\.git$/, '') || 'repo';
    dir = path.join(os.homedir(), 'git-nd-repos', name);
  }
  dir = path.resolve(dir);
  if (fs.existsSync(dir) && fs.readdirSync(dir).length > 0) {
    throw new AppError(`Target directory is not empty: ${dir}`, 400);
  }
  await fsp.mkdir(dir, { recursive: true });
  await git.clone({ fs, http, dir, url, onAuth: authFor(url, tokens) });
  repoState.open(dir);
  return dir;
}

export async function currentBranch() {
  const dir = repoState.requireRepo();
  return (await git.currentBranch({ fs, dir, fullname: false })) || '(detached)';
}

export async function repoInfo() {
  const dir = repoState.requireRepo();
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
  const matrix = await git.statusMatrix({ fs, dir });
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

export async function discard(filepath) {
  const dir = repoState.requireRepo();
  const rel = repoState.relPath(filepath);
  try {
    await git.checkout({ fs, dir, force: true, filepaths: [rel] });
  } catch {
    // Untracked file: checkout has nothing to restore, just delete it.
    await fsp.rm(repoState.safePath(filepath), { force: true });
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
  if (!message?.trim()) throw new AppError('Commit message is required', 400);
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
  const matrix = await git.statusMatrix({ fs, dir });
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
  parents: c.commit.parent,
});

export async function history({ depth = 100, ref } = {}) {
  const dir = repoState.requireRepo();
  const commits = await git.log({ fs, dir, depth: Number(depth), ref: ref || undefined });
  return commits.map(mapCommit);
}

/**
 * Commits across ALL branches (local + origin) with branch tip labels,
 * topologically sorted so the graph can draw how branches interact.
 */
export async function historyAll({ depth = 100 } = {}) {
  const dir = repoState.requireRepo();
  const { current, local, remote } = await listBranches();
  const seen = new Map(); // oid → commit
  const tips = {};        // oid → [{ name, remote, current }]

  for (const name of [...local, ...remote]) {
    try {
      const log = await git.log({ fs, dir, ref: name, depth: Number(depth) });
      if (log[0]) {
        (tips[log[0].oid] ||= []).push({
          name,
          remote: name.includes('/'),
          current: name === current,
        });
      }
      for (const c of log) if (!seen.has(c.oid)) seen.set(c.oid, mapCommit(c));
    } catch { /* dangling ref */ }
  }

  let headOid = null;
  try { headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' }); } catch { /* empty repo */ }
  return { commits: topoSort([...seen.values()]), tips, headOid, current };
}

/** Children before parents (required by the lane algorithm), newest-first tie-break. */
function topoSort(commits) {
  const byOid = new Map(commits.map((c) => [c.oid, c]));
  const pendingChildren = new Map(commits.map((c) => [c.oid, 0]));
  for (const c of commits) {
    for (const p of c.parents) {
      if (byOid.has(p)) pendingChildren.set(p, pendingChildren.get(p) + 1);
    }
  }
  const ready = commits.filter((c) => pendingChildren.get(c.oid) === 0);
  const order = [];
  while (ready.length > 0) {
    ready.sort((a, b) => a.date - b.date);
    const c = ready.pop(); // newest available first
    order.push(c);
    for (const p of c.parents) {
      if (!byOid.has(p)) continue;
      const left = pendingChildren.get(p) - 1;
      pendingChildren.set(p, left);
      if (left === 0) ready.push(byOid.get(p));
    }
  }
  return order;
}

/** Files touched by a commit (vs its first parent), for the detail view. */
export async function commitDetail(oid) {
  const dir = repoState.requireRepo();
  const c = await git.readCommit({ fs, dir, oid });
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

export async function resetToCommit(oid) {
  const dir = repoState.requireRepo();
  const branch = await git.currentBranch({ fs, dir, fullname: false });
  if (!branch) throw new AppError('Detached HEAD: cannot reset', 400);
  await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true });
  await git.checkout({ fs, dir, ref: branch, force: true });
  repoState.merge = null;
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
  if (repoState.merge) throw new AppError('A merge is in progress: resolve or abort it first', 409);

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
  const url = await remoteUrl(dir, remote);
  const res = await git.push({
    fs, http, dir, remote, ref: branch, onAuth: authFor(url, tokens),
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

  const [localLog, remoteLog] = await Promise.all([
    git.log({ fs, dir, ref: branch, depth: 300 }),
    git.log({ fs, dir, ref: theirRef, depth: 300 }),
  ]);
  const localSet = new Set(localLog.map((c) => c.oid));
  const remoteSet = new Set(remoteLog.map((c) => c.oid));
  return {
    branch,
    hasUpstream: true,
    ahead: localLog.filter((c) => !remoteSet.has(c.oid)).length,
    behind: remoteLog.filter((c) => !localSet.has(c.oid)).length,
  };
}

async function doMerge(theirRef, author) {
  const dir = repoState.requireRepo();
  const ours = await currentBranch();
  const theirOid = await git.resolveRef({ fs, dir, ref: theirRef });
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
      return { conflicts: files };
    }
    throw err;
  }
}

export async function pull({ remote = 'origin', tokens, author, rebase = false }) {
  const dir = repoState.requireRepo();
  if (repoState.merge) throw new AppError('A merge is in progress: resolve or abort it first', 409);
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

  const matrix = await git.statusMatrix({ fs, dir });
  const dirty = matrix.some(([, head, workdir, stage]) => !(head === 1 && workdir === 1 && stage === 1));
  if (dirty) throw new AppError('Working tree has local changes: commit or stash them before rebasing', 409);

  const remoteOid = await git.resolveRef({ fs, dir, ref: theirRef });
  const localOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
  if (localOid === remoteOid) return { upToDate: true };

  const [localLog, remoteLog] = await Promise.all([
    git.log({ fs, dir, ref: branch, depth: 300 }),
    git.log({ fs, dir, ref: theirRef, depth: 300 }),
  ]);
  const remoteSet = new Set(remoteLog.map((c) => c.oid));

  if (remoteSet.has(localOid)) { // no local commits → fast-forward
    await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: remoteOid, force: true });
    await git.checkout({ fs, dir, ref: branch, force: true });
    return { rebased: true, fastForward: true };
  }
  if (localLog.some((c) => c.oid === remoteOid)) {
    return { upToDate: true, note: 'You are ahead of the remote; nothing to rebase' };
  }

  const toReplay = [];
  for (const c of localLog) {
    if (remoteSet.has(c.oid)) break;
    toReplay.push(c);
  }
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
  if (repoState.merge) throw new AppError('A merge is in progress: resolve or abort it first', 409);
  const who = await resolveAuthor(dir, author);
  return doMerge(theirRef, who);
}

/* ------------------------------------------------------------ conflicts --- */

export async function completeMerge({ message, author }) {
  const dir = repoState.requireRepo();
  const merge = repoState.merge;
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
  repoState.merge = null;
  return { oid, merged: true };
}

export async function abortMerge() {
  const dir = repoState.requireRepo();
  if (!repoState.merge) throw new AppError('No merge in progress', 400);
  const branch = await currentBranch();
  await git.checkout({ fs, dir, ref: branch, force: true });
  repoState.merge = null;
}

/* ---------------------------------------------------------------- diff --- */

async function headContent(dir, rel) {
  try {
    const headOid = await git.resolveRef({ fs, dir, ref: 'HEAD' });
    const { blob } = await git.readBlob({ fs, dir, oid: headOid, filepath: rel });
    return new TextDecoder().decode(blob);
  } catch {
    return ''; // new file
  }
}

const blobText = async (dir, oid, rel) => {
  try {
    const { blob } = await git.readBlob({ fs, dir, oid, filepath: rel });
    return new TextDecoder().decode(blob);
  } catch {
    return ''; // file absent at that commit
  }
};

/**
 * Without oid: HEAD vs working directory (uncommitted changes).
 * With oid: that commit vs its first parent (what the commit changed).
 */
export async function diffFile(filepath, oid) {
  const dir = repoState.requireRepo();
  const rel = repoState.relPath(filepath);

  if (oid) {
    const c = await git.readCommit({ fs, dir, oid });
    const parent = c.commit.parent[0] || null;
    const oldText = parent ? await blobText(dir, parent, rel) : '';
    const newText = await blobText(dir, oid, rel);
    return { filepath: rel, oid, rows: sideBySideRows(oldText, newText) };
  }

  const abs = repoState.safePath(filepath);
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

/* ---------------------------------------------------------------- stash --- */

export async function stash(op, message) {
  const dir = repoState.requireRepo();
  const result = await git.stash({ fs, dir, op, message });
  return result ?? null;
}

/* ----------------------------------------------------------- tree/files --- */

export async function tree(dirPath = '.') {
  const abs = repoState.safePath(dirPath);
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
  const abs = repoState.safePath(filepath);
  const stat = await fsp.stat(abs);
  if (stat.size > 2 * 1024 * 1024) throw new AppError('File too large to display', 413);
  const buf = await fsp.readFile(abs);
  const isBinary = buf.subarray(0, 8000).includes(0);
  return { filepath, binary: isBinary, content: isBinary ? null : buf.toString('utf8'), size: stat.size };
}

export async function writeFile(filepath, content) {
  const abs = repoState.safePath(filepath);
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, 'utf8');
}

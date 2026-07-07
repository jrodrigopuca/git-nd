import { Router } from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import * as gitSvc from '../gitService.js';
import { broadcast } from '../state.js';
import { tokenStore } from '../tokenStore.js';

export const repoRouter = Router();

/** Wrap async handlers so thrown errors reach the error middleware. */
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then(
  (data) => { if (!res.headersSent) res.json(data ?? { ok: true }); },
  next,
);

/* ---- filesystem browser (Explorer view): directories only ---- */
repoRouter.get('/api/fs/browse', h(async (req) => {
  const target = path.resolve(req.query.path || os.homedir());
  const entries = await fsp.readdir(target, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({
      name: e.name,
      path: path.join(target, e.name),
      isRepo: fs.existsSync(path.join(target, e.name, '.git')),
    }))
    .sort((a, b) => (b.isRepo - a.isRepo) || a.name.localeCompare(b.name));
  const parent = path.dirname(target);
  return {
    path: target,
    parent: parent !== target ? parent : null,
    isRepo: fs.existsSync(path.join(target, '.git')),
    entries: dirs,
  };
}));

/* ---- open / clone ---- */
repoRouter.post('/api/repo/open', h(async (req) => {
  const dir = gitSvc.openRepo(req.body.dir);
  broadcast('repo-opened', { dir });
  return gitSvc.repoInfo();
}));

repoRouter.post('/api/repo/clone', h(async (req) => {
  const dir = await gitSvc.cloneRepo(req.body.url, req.body.dir, tokenStore.tokens());
  broadcast('repo-opened', { dir });
  return gitSvc.repoInfo();
}));

repoRouter.get('/api/repo/info', h(() => gitSvc.repoInfo()));

/* ---- status / tree / files ---- */
repoRouter.get('/api/repo/status', h(() => gitSvc.status()));
repoRouter.get('/api/repo/tree', h((req) => gitSvc.tree(req.query.path || '.')));
repoRouter.get('/api/repo/files', h(() => gitSvc.flatFileList()));
repoRouter.get('/api/repo/file', h((req) => gitSvc.readFile(req.query.path)));

repoRouter.post('/api/repo/file', h(async (req) => {
  await gitSvc.writeFile(req.body.path, req.body.content);
  broadcast('file-changed', { path: req.body.path });
}));

/* ---- staging ---- */
repoRouter.post('/api/repo/stage', h((req) => gitSvc.stage(req.body.path)));
repoRouter.post('/api/repo/unstage', h((req) => gitSvc.unstage(req.body.path)));
repoRouter.post('/api/repo/discard', h((req) => gitSvc.discard(req.body.path)));
repoRouter.post('/api/repo/stage-all', h(() => gitSvc.stageAll()));
repoRouter.post('/api/repo/unstage-all', h(() => gitSvc.unstageAll()));

/* ---- commit / history ---- */
repoRouter.post('/api/repo/commit', h(async (req) => {
  const result = await gitSvc.commit(req.body);
  broadcast('commit-completed', result);
  return result;
}));

repoRouter.get('/api/repo/history', h((req) =>
  req.query.all ? gitSvc.historyAll(req.query) : gitSvc.history(req.query)));

repoRouter.get('/api/repo/sync', h((req) =>
  gitSvc.syncStatus({ tokens: tokenStore.tokens(), doFetch: req.query.fetch === '1' })));
repoRouter.get('/api/repo/author', h(() => gitSvc.getAuthor()));
repoRouter.post('/api/repo/author', h((req) => gitSvc.setAuthor(req.body)));

repoRouter.post('/api/repo/reset', h(async (req) => {
  const result = await gitSvc.resetToCommit(req.body.oid);
  broadcast('branch-changed', result);
  return result;
}));

/* ---- push / pull / merge ---- */
repoRouter.post('/api/repo/push', h(async (req) => {
  const result = await gitSvc.push({ ...req.body, tokens: tokenStore.tokens() });
  broadcast('push-finished', result);
  return result;
}));

repoRouter.post('/api/repo/pull', h(async (req) => {
  const result = await gitSvc.pull({ ...req.body, tokens: tokenStore.tokens() });
  broadcast('pull-finished', result);
  return result;
}));

repoRouter.post('/api/repo/merge', h(async (req) => {
  const result = await gitSvc.mergeBranch(req.body);
  broadcast('merge-updated', result);
  return result;
}));

repoRouter.post('/api/repo/merge/abort', h(async () => {
  await gitSvc.abortMerge();
  broadcast('merge-updated', { aborted: true });
}));

/* ---- diff / commit detail ---- */
repoRouter.get('/api/repo/diff', h((req) => gitSvc.diffFile(req.query.file, req.query.oid)));
repoRouter.get('/api/repo/commit', h((req) => gitSvc.commitDetail(req.query.oid)));

/* ---- branches ---- */
repoRouter.get('/api/repo/branches', h(() => gitSvc.listBranches()));

repoRouter.post('/api/repo/branch/create', h(async (req) => {
  await gitSvc.createBranch(req.body.name, req.body.checkout !== false);
  broadcast('branch-changed', { branch: req.body.name });
}));

repoRouter.post('/api/repo/branch/switch', h(async (req) => {
  const result = await gitSvc.switchBranch(req.body.name);
  broadcast('branch-changed', result);
  return result;
}));

repoRouter.post('/api/repo/branch/delete', h((req) => gitSvc.deleteBranch(req.body.name)));

/* ---- stash ---- */
repoRouter.get('/api/repo/stash', h(async () => ({ list: (await gitSvc.stash('list')) || [] })));
repoRouter.post('/api/repo/stash', h(async (req) => {
  const result = await gitSvc.stash(req.body.op || 'push', req.body.message);
  broadcast('stash-updated', { op: req.body.op });
  return { result };
}));

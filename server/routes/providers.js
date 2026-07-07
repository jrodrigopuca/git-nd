import { Router } from 'express';
import { getProvider } from '../providers/index.js';
import { AppError } from '../state.js';
import { tokenStore } from '../tokenStore.js';

export const providersRouter = Router();

const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res)).then(
  (data) => res.json(data ?? { ok: true }),
  next,
);

function tokenFor(req, provider) {
  const token = tokenStore.get(provider);
  if (!token) throw new AppError(`Not authenticated with ${provider}: connect it in the Connections view`, 401);
  return token;
}

/* GET /api/providers/list?provider=github → user repos */
providersRouter.get('/api/providers/list', h(async (req) => {
  const provider = req.query.provider || 'github';
  const token = tokenFor(req, provider);
  return { provider, repos: await getProvider(provider).listRepos(token) };
}));

/* POST /api/providers/pr { provider, repo, title, body, sourceBranch, targetBranch } */
providersRouter.post('/api/providers/pr', h(async (req) => {
  const { provider = 'github', ...params } = req.body;
  const token = tokenFor(req, provider);
  return getProvider(provider).createPullRequest(token, params);
}));

/* GET /api/providers/prs?provider=github&repo=owner/name → open PRs/MRs */
providersRouter.get('/api/providers/prs', h(async (req) => {
  const { provider = 'github', repo } = req.query;
  const token = tokenFor(req, provider);
  return { prs: await getProvider(provider).listPullRequests(token, { repo }) };
}));

/* GET /api/providers/issues?provider=github&repo=owner/name */
providersRouter.get('/api/providers/issues', h(async (req) => {
  const { provider = 'github', repo } = req.query;
  const token = tokenFor(req, provider);
  return { issues: await getProvider(provider).listIssues(token, { repo }) };
}));

/* POST /api/providers/issues { provider, repo, title, body } */
providersRouter.post('/api/providers/issues', h(async (req) => {
  const { provider = 'github', ...params } = req.body;
  const token = tokenFor(req, provider);
  return getProvider(provider).createIssue(token, params);
}));

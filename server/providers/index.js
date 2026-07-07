import { GitHubProvider } from './github.js';
import { GitLabProvider } from './gitlab.js';
import { AppError } from '../state.js';

/**
 * Provider registry. Every provider implements the same interface:
 *   getUser(token) → { login, name, avatar }
 *   listRepos(token) → [{ id, name, fullName, private, cloneUrl, webUrl, description }]
 *   createPullRequest(token, { repo, title, body, sourceBranch, targetBranch }) → { url, number }
 *   listIssues(token, { repo }) → [{ number, title, state, author, url, createdAt }]
 *   createIssue(token, { repo, title, body }) → { url, number }
 *   oauth: { authorizeUrl(clientId, redirect, state), exchangeCode(code, redirect) }
 *
 * To add Bitbucket/Gitea: create the class and register it here. That's it.
 */
const providers = {
  github: new GitHubProvider(),
  gitlab: new GitLabProvider(),
};

export function getProvider(name) {
  const p = providers[name];
  if (!p) throw new AppError(`Unknown provider: ${name}`, 400);
  return p;
}

export function listProviders() {
  return Object.keys(providers);
}

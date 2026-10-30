/**
 * Which stored token (if any) may be sent to a git remote.
 *
 * Tokens are only ever offered to the provider they belong to, matched by
 * EXACT host, and only over https — a remote URL is repo-controlled data
 * (a cloned or opened repo picks its own `origin`), so "does the host look
 * like GitHub" is not a check. Before this, any host answering 401 received
 * the GitHub token, over plain http too (BACKLOG B-01).
 *
 * The one http exception: a self-hosted GitLab the user configured
 * explicitly as `GITLAB_URL=http://…` gets its token over http.
 */

export const GITHUB_HOST = 'github.com';

function gitlabBase() {
  try {
    return new URL(process.env.GITLAB_URL || 'https://gitlab.com');
  } catch {
    return new URL('https://gitlab.com');
  }
}

/** Human-readable list of where tokens go, for error messages. */
export function credentialHosts() {
  const gl = gitlabBase();
  return `https://${GITHUB_HOST} (GitHub token) and ${gl.protocol}//${gl.host} (GitLab token)`;
}

/**
 * Basic-auth credentials for `url`, or null when no token may be sent there.
 * @param {string} url remote URL
 * @param {{ github?: string, gitlab?: string }} tokens
 */
export function credentialsFor(url, tokens = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null; // ssh / scp-like URLs: no token over those
  }
  const gl = gitlabBase();
  if (tokens.gitlab && u.host === gl.host && (u.protocol === 'https:' || u.protocol === gl.protocol)) {
    return { username: 'oauth2', password: tokens.gitlab };
  }
  if (tokens.github && u.host === GITHUB_HOST && u.protocol === 'https:') {
    return { username: tokens.github, password: 'x-oauth-basic' };
  }
  return null;
}

/**
 * isomorphic-git `onAuth` callback: the token for the URL ACTUALLY being
 * requested (isomorphic-git passes it), or cancel. Deciding from
 * remote.origin.url instead let a repo's `pushurl` receive the token meant
 * for origin's host (BACKLOG B-01, reopened).
 */
export function authFor(tokens = {}) {
  return (requestUrl) => credentialsFor(requestUrl, tokens) || { cancel: true };
}

/**
 * Network options for every clone/fetch/push. `corsProxy: null` (not
 * undefined) stops isomorphic-git from reading `http.corsProxy` from the repo
 * config: a proxy chosen by the repo would see the requests, and a token sent
 * "to github.com" would travel to the proxy (BACKLOG B-01, reopened).
 */
export const NO_REPO_PROXY = { corsProxy: null };

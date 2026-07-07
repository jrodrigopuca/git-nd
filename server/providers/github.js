import { AppError } from '../state.js';

const API = 'https://api.github.com';

async function gh(token, endpoint, options = {}) {
  const res = await fetch(`${API}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new AppError(`GitHub: ${body.message || res.statusText}`, res.status);
  }
  return res.json();
}

export class GitHubProvider {
  name = 'github';

  async getUser(token) {
    const u = await gh(token, '/user');
    return {
      login: u.login,
      name: u.name || u.login,
      avatar: u.avatar_url,
      // Public email, or the noreply address GitHub attributes commits to.
      email: u.email || `${u.id}+${u.login}@users.noreply.github.com`,
    };
  }

  async listRepos(token) {
    const repos = await gh(token, '/user/repos?per_page=100&sort=updated');
    return repos.map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      private: r.private,
      cloneUrl: r.clone_url,
      webUrl: r.html_url,
      description: r.description,
      defaultBranch: r.default_branch,
    }));
  }

  async createPullRequest(token, { repo, title, body, sourceBranch, targetBranch }) {
    const pr = await gh(token, `/repos/${repo}/pulls`, {
      method: 'POST',
      body: JSON.stringify({ title, body: body || '', head: sourceBranch, base: targetBranch }),
    });
    return { url: pr.html_url, number: pr.number };
  }

  async listIssues(token, { repo }) {
    const issues = await gh(token, `/repos/${repo}/issues?state=open&per_page=50`);
    return issues
      .filter((i) => !i.pull_request)
      .map((i) => ({
        number: i.number,
        title: i.title,
        state: i.state,
        author: i.user?.login,
        url: i.html_url,
        createdAt: i.created_at,
      }));
  }

  async createIssue(token, { repo, title, body }) {
    const issue = await gh(token, `/repos/${repo}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title, body: body || '' }),
    });
    return { url: issue.html_url, number: issue.number };
  }

  oauth = {
    authorizeUrl(clientId, redirect, state) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        scope: 'repo read:user',
        state,
      });
      return `https://github.com/login/oauth/authorize?${q}`;
    },
    async exchangeCode(code, redirect) {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          client_id: process.env.GITHUB_CLIENT_ID,
          client_secret: process.env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: redirect,
        }),
      });
      const data = await res.json();
      if (!data.access_token) throw new AppError(`GitHub OAuth failed: ${data.error_description || 'no token returned'}`, 401);
      return data.access_token;
    },
  };
}

import { AppError } from '../state.js';

const API = process.env.GITLAB_URL || 'https://gitlab.com';

async function gl(token, endpoint, options = {}) {
  const res = await fetch(`${API}/api/v4${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const msg = typeof body.message === 'object' ? JSON.stringify(body.message) : body.message;
    throw new AppError(`GitLab: ${msg || res.statusText}`, res.status);
  }
  return res.json();
}

export class GitLabProvider {
  name = 'gitlab';

  async getUser(token) {
    const u = await gl(token, '/user');
    return {
      login: u.username,
      name: u.name || u.username,
      avatar: u.avatar_url,
      email: u.commit_email || u.email || u.public_email || null,
    };
  }

  async listRepos(token) {
    const projects = await gl(token, '/projects?membership=true&per_page=100&order_by=last_activity_at');
    return projects.map((p) => ({
      id: p.id,
      name: p.name,
      fullName: p.path_with_namespace,
      private: p.visibility !== 'public',
      cloneUrl: p.http_url_to_repo,
      webUrl: p.web_url,
      description: p.description,
      defaultBranch: p.default_branch,
    }));
  }

  async createPullRequest(token, { repo, title, body, sourceBranch, targetBranch }) {
    const mr = await gl(token, `/projects/${encodeURIComponent(repo)}/merge_requests`, {
      method: 'POST',
      body: JSON.stringify({
        title,
        description: body || '',
        source_branch: sourceBranch,
        target_branch: targetBranch,
      }),
    });
    return { url: mr.web_url, number: mr.iid };
  }

  async listIssues(token, { repo }) {
    const issues = await gl(token, `/projects/${encodeURIComponent(repo)}/issues?state=opened&per_page=50`);
    return issues.map((i) => ({
      number: i.iid,
      title: i.title,
      state: i.state,
      author: i.author?.username,
      url: i.web_url,
      createdAt: i.created_at,
    }));
  }

  async createIssue(token, { repo, title, body }) {
    const issue = await gl(token, `/projects/${encodeURIComponent(repo)}/issues`, {
      method: 'POST',
      body: JSON.stringify({ title, description: body || '' }),
    });
    return { url: issue.web_url, number: issue.iid };
  }

  oauth = {
    authorizeUrl(clientId, redirect, state) {
      const q = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirect,
        response_type: 'code',
        scope: 'api read_user',
        state,
      });
      return `${API}/oauth/authorize?${q}`;
    },
    async exchangeCode(code, redirect) {
      const res = await fetch(`${API}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: process.env.GITLAB_CLIENT_ID,
          client_secret: process.env.GITLAB_CLIENT_SECRET,
          code,
          grant_type: 'authorization_code',
          redirect_uri: redirect,
        }),
      });
      const data = await res.json();
      if (!data.access_token) throw new AppError(`GitLab OAuth failed: ${data.error_description || 'no token returned'}`, 401);
      return data.access_token;
    },
  };
}

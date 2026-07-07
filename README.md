# 🌿 git-nd

Local Git client with a web UI. Runs at `http://localhost:3847` and manages real repositories on your disk using [isomorphic-git](https://isomorphic-git.org/) on the server side (Node + Express) — no `git` binary required.

Where this is heading: see [ROADMAP.md](./ROADMAP.md).

## Quick start

```bash
pnpm install
pnpm start
# → http://localhost:3847
```

For development with auto-reload: `pnpm dev`.

## Features

The app is organized into three views (activity bar on the left, IDE-style):

- **🗂️ Explorer** — recent repositories, a filesystem browser that highlights Git repos (🌿), and your remote GitHub/GitLab repos ready to clone
- **📗 Repository** — the working view: tree, editor, diffs, graph, changes, branches, history, stash, PRs
- **🔌 Connections** — provider accounts (OAuth or PAT), with identity and sign-out per provider

- **Open / clone** local or remote repositories (HTTP/HTTPS)
- **Tree view** with lazy loading, per-filetype icons, status indicators (M/U/D/!) and drag & drop to add files
- **File editor**: open any file from the tree and edit it in place (`Ctrl+S` to save)
- **Changes**: stage / unstage / discard per file, with side-by-side diff
- **Hunk staging**: click a changed file and stage, unstage, or discard each hunk independently — build atomic commits by picking exactly the changes you want (workdir vs index and index vs HEAD views)
- **Commit** with message and editable author (`Name <email>`)
- **Push / Pull** with token authentication (OAuth or PAT), private repos included
- **Pull with rebase**: replay your commits on top of the remote for linear history (mode picker next to Pull; aborts safely on conflicts and suggests merge)
- **Ahead/behind indicators**: Fetch button + auto-fetch every 2 min; incoming/outgoing counts as badges on Pull/Push, Sourcetree-style
- **Branches**: create, switch, delete, merge; checking out a remote branch (`origin/x`) creates and switches to the matching local branch; multi-branch SVG commit graph with branch labels (current branch highlighted, remotes dashed)
- **History**: commit list + revert (hard reset) to any commit; click a commit to see its changed files and per-file line diff
- **Author identity, git-style**: resolution order is repo `.git/config` → connected provider account matching the repo's origin (GitHub/GitLab, using the provider's commit email) → app-wide default (`~/.git-nd/settings.json`). Committing pins the identity to that repo, so each repo can carry its own user/email (work vs personal); the global default is seeded once and never clobbered
- **Stage all / unstage all** with one click; empty commits are blocked (a commit snapshots the index — nothing staged, nothing to commit)
- **Merge view**: any merge with conflicts (pull, local or remote branch) opens a dedicated ⚡ Merge tab — which branches are merging, incoming commits, every affected file (conflicted vs auto-merged), a progress bar, and Complete/Abort actions. Complete only unlocks when every conflict is resolved
- **Visual conflict resolution**: each conflict is a card showing LOCAL (green) and INCOMING (blue) side by side with branch labels; resolve per conflict with Keep local / Take incoming / Both / Edit, watch the `2/3 resolved` progress, and Save only unlocks when everything is settled. Unchanged context collapses out of the way. A raw text mode remains for hand editing, and merges complete with a default `Merge <ref>` message. Resolving a file returns you to the Merge view to pick the next one
- **PRs / MRs**: list open pull requests (GitHub) / merge requests (GitLab) with source → target branches, and jump to them in the browser. Creating a PR uses branch dropdowns (no typing), shows a live preview of the commits and files the PR would carry (click a file for its line diff), and warns if the source branch hasn't been pushed yet
- **Stash**: save, apply, pop
- **GitHub / GitLab**: list your repos (public and private), one-click clone, create Pull/Merge Requests, list and create issues
- **UX**: dark/light mode, toasts, spinners, recent repos, real-time events over WebSockets

## Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl/Cmd + S` | Commit — or save file when the File tab is active |
| `Ctrl/Cmd + Shift + P` | Push |
| `Ctrl/Cmd + P` | Go to file (quick open) |
| `Esc` | Close modal |

## Authentication

### Option A: Personal access token (PAT) — works with zero config

1. Click **👤 Connect**
2. Paste a token:
   - GitHub: <https://github.com/settings/tokens> (scope `repo`)
   - GitLab: <https://gitlab.com/-/user_settings/personal_access_tokens> (scope `api`)

### Option B: OAuth

Register an OAuth app and export the variables before starting:

```bash
# GitHub → Settings → Developer settings → OAuth Apps
#   Callback URL: http://localhost:3847/auth/github/callback
export GITHUB_CLIENT_ID=xxx
export GITHUB_CLIENT_SECRET=xxx

# GitLab → Preferences → Applications
#   Redirect URI: http://localhost:3847/auth/gitlab/callback  (scopes: api, read_user)
export GITLAB_CLIENT_ID=xxx
export GITLAB_CLIENT_SECRET=xxx

pnpm start
```

### Token storage

Tokens are **never** kept in the browser. They are stored server-side, encrypted with **AES-256-GCM**, in `~/.git-nd/tokens.enc`, so they survive server restarts. The encryption key lives in `~/.git-nd/secret.key` (file mode `0600`), or can be supplied via the `GITND_KEY` env var (32 bytes, hex). This protects tokens at rest (backups, sync tools); anyone who can read both files as your OS user can still decrypt — that is the ceiling for any local app that does not use an OS keychain.

## REST API

| Method | Endpoint | Description |
| --- | --- | --- |
| GET | `/api/fs/browse?path=` | Browse directories, flagging Git repos (Explorer) |
| POST | `/api/repo/open` | Open local repo `{ dir }` |
| POST | `/api/repo/clone` | Clone `{ url, dir? }` |
| GET | `/api/repo/status` | Status (staged/unstaged/untracked/conflicted) |
| GET | `/api/repo/tree?path=.` | Tree view (one level, lazy) |
| GET | `/api/repo/file?path=` | Read a file |
| POST | `/api/repo/file` | Write a file `{ path, content }` |
| GET | `/api/repo/history?depth=80` | Commits with parents |
| POST | `/api/repo/commit` | `{ message, author? }` |
| POST | `/api/repo/push` / `pull` | Sync with `origin` (`pull` accepts `{ rebase: true }`) |
| GET | `/api/repo/sync?fetch=1` | Ahead/behind vs `origin/<branch>` |
| POST | `/api/repo/stage-all` / `unstage-all` | Bulk staging |
| GET | `/api/repo/diff?file=&oid=` | Side-by-side diff (workdir vs HEAD, or what a commit changed) |
| GET | `/api/repo/commit?oid=` | Commit detail: metadata + changed files |
| POST | `/api/repo/branch/create` / `switch` / `delete` | Branches |
| POST | `/api/repo/merge` | Merge another branch `{ theirRef }` |
| POST | `/api/repo/merge/abort` | Abort merge in progress |
| POST | `/api/repo/reset` | Hard reset `{ oid }` |
| POST | `/api/repo/stash` | `{ op: push\|apply\|pop\|drop }` |
| GET | `/api/providers/list?provider=` | Authenticated user's repos |
| POST | `/api/providers/pr` | Create PR/MR |
| GET/POST | `/api/providers/issues` | List / create issues |

WebSocket at `/ws` emits: `commit-completed`, `push-finished`, `pull-finished`, `branch-changed`, `merge-updated`, `stash-updated`, `repo-opened`, `file-changed`.

## Architecture

```
server/
  index.js            Express + WebSocket + friendly error handling
  state.js            Open repo, merge state, WS event bus
  gitService.js       All Git logic (isomorphic-git + Node fs)
  tokenStore.js       AES-256-GCM encrypted token persistence (~/.git-nd)
  routes/             repo, auth (OAuth + PAT), providers
  providers/          GitHub/GitLab abstraction (common interface →
                      adding Bitbucket/Gitea = one new class)
public/               Vanilla frontend (ES modules, no build step)
```

### Decisions

- **isomorphic-git with Node's `fs`** (not LightningFS): LightningFS is a browser virtual FS (IndexedDB); with a Node backend, using the real filesystem lets you open existing local repos.
- **Security**: tokens encrypted at rest on the server; every file path is validated against the open repo directory (no path traversal); the server listens on `127.0.0.1` only; `Host` and `Origin` allowlists block CSRF and DNS-rebinding attacks on both HTTP and WebSocket (see `ROADMAP.md` T1.1).
- **Errors**: isomorphic-git error codes are translated into clear messages; stacktraces are never sent to the frontend.

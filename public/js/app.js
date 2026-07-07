import { api, withUi, onEvent } from './api.js';
import { el, toast, openModal, closeModal, confirmModal, fileIcon } from './ui.js';
import { refreshTree, setStatusMap, setOpenFileHandler, initTreeDnD } from './tree.js';
import { renderDiff } from './diff.js';
import { renderGraph } from './graph.js';

const $ = (id) => document.getElementById(id);
let repo = null;       // current repo info
let authStatus = null; // provider connection status

/* ================================================================ views === */

function switchView(name) {
  document.querySelectorAll('.act-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'explorer') renderExplorer();
  if (name === 'connections') renderConnections();
}
document.querySelectorAll('.act-btn').forEach((b) =>
  b.addEventListener('click', () => switchView(b.dataset.view)));

/* ================================================================= tabs === */

function showTab(name) {
  document.querySelectorAll('.tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === name);
    if (['file', 'diff', 'conflict'].includes(t.dataset.tab) && t.dataset.tab === name) t.hidden = false;
  });
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('active', c.id === `tab-${name}`));
}
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => showTab(t.dataset.tab)));

const activeTab = () => document.querySelector('.tab.active')?.dataset.tab;

/* ============================================================== recents === */

const getRecents = () => JSON.parse(localStorage.getItem('gitnd-recents') || '[]');

function addRecent(dir) {
  const list = [dir, ...getRecents().filter((d) => d !== dir)].slice(0, 8);
  localStorage.setItem('gitnd-recents', JSON.stringify(list));
}

/* ======================================================== explorer view === */

let browsePath = null;

function renderExplorer() {
  $('ex-recents').replaceChildren(
    ...getRecents().map((dir) =>
      el('li', { onclick: () => openRepo(dir) }, '🌿', dir)),
  );
  if (getRecents().length === 0) {
    $('ex-recents').replaceChildren(el('li', { class: 'muted', style: 'cursor:default' }, 'Nothing yet — open a repo below.'));
  }
  browseTo(browsePath);
  renderExplorerRemote();
}

async function browseTo(path) {
  const data = await api.get(`/api/fs/browse${path ? `?path=${encodeURIComponent(path)}` : ''}`)
    .catch((e) => { toast(e.message, 'error'); return null; });
  if (!data) return;
  browsePath = data.path;
  $('ex-path').value = data.path;
  $('ex-up').disabled = !data.parent;
  $('ex-up').onclick = () => data.parent && browseTo(data.parent);

  $('ex-open-here').replaceChildren(
    data.isRepo
      ? el('button', { class: 'btn btn-primary', style: 'margin-bottom:8px', onclick: () => openRepo(data.path) },
          `🌿 Open this repository (${data.path.split('/').pop()})`)
      : '',
  );
  $('ex-dirs').replaceChildren(...data.entries.map((e) =>
    el('li', { onclick: () => (e.isRepo ? openRepo(e.path) : browseTo(e.path)) },
      e.isRepo ? '🌿' : '📁', e.name,
      el('span', { class: 'muted-right' }, e.isRepo ? 'git repository — click to open' : ''),
    )));
  if (data.entries.length === 0) {
    $('ex-dirs').replaceChildren(el('li', { class: 'muted', style: 'cursor:default' }, 'No folders here.'));
  }
}

$('ex-path').addEventListener('keydown', (e) => { if (e.key === 'Enter') browseTo($('ex-path').value.trim()); });
$('ex-goto-conn').addEventListener('click', (e) => { e.preventDefault(); switchView('connections'); });

async function renderExplorerRemote() {
  const connected = authStatus?.providers.filter((p) => p.connected) || [];
  const box = $('ex-remote-box');
  if (connected.length === 0) {
    $('ex-remote-provider').textContent = '';
    box.replaceChildren(
      el('p', { class: 'muted' }, 'Connect a provider in ',
        el('a', { href: '#', onclick: (e) => { e.preventDefault(); switchView('connections'); } }, 'Connections'),
        ' to list your repos.'),
    );
    return;
  }
  const provider = connected[0].name;
  $('ex-remote-provider').textContent = `— ${provider}`;
  const filter = el('input', { type: 'text', placeholder: 'Filter…', style: 'margin-bottom:8px' });
  const list = el('ul', { class: 'pick-list' }, el('li', { class: 'muted', style: 'cursor:default' }, 'Loading…'));
  box.replaceChildren(filter, list);

  const data = await api.get(`/api/providers/list?provider=${provider}`).catch((e) => { toast(e.message, 'error'); return null; });
  if (!data) { list.replaceChildren(el('li', { class: 'muted', style: 'cursor:default' }, 'Could not load repos.')); return; }
  const render = () => {
    const q = filter.value.toLowerCase();
    list.replaceChildren(...data.repos
      .filter((r) => r.fullName.toLowerCase().includes(q))
      .slice(0, 40)
      .map((r) => el('li', { onclick: () => cloneModal(r.cloneUrl) },
        r.private ? '🔒' : '📖', r.fullName,
        el('span', { class: 'muted-right' }, 'clone'),
      )));
  };
  filter.addEventListener('input', render);
  render();
}

/* ===================================================== connections view === */

async function renderConnections() {
  authStatus = await api.get('/api/auth/status').catch(() => null);
  updateAuthButton();
  const cards = (authStatus?.providers || []).map((p) => {
    const patInput = el('input', { type: 'password', placeholder: `${p.name} personal access token (PAT)` });
    const connectWithPat = async () => {
      const r = await withUi(
        api.post('/api/auth/token', { provider: p.name, token: patInput.value.trim() }),
        { loading: 'Validating token…' },
      );
      if (r) { toast(`Connected to ${p.name} as ${r.user.login} ✔`, 'success'); renderConnections(); }
    };
    patInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') connectWithPat(); });

    return el('div', { class: 'conn-card' },
      el('h2', {}, p.name === 'github' ? '🐙 GitHub' : '🦊 GitLab'),
      p.connected
        ? el('div', { class: 'col' },
            el('div', { class: 'row' },
              p.user?.avatar ? el('img', { class: 'avatar', src: p.user.avatar, alt: '' }) : null,
              el('div', {},
                el('div', {}, `${p.user?.name || p.user?.login} ✔`),
                el('div', { class: 'muted', style: 'font-size:11.5px' }, p.user?.email || p.user?.login)),
            ),
            el('div', { class: 'row' },
              el('button', {
                class: 'btn', onclick: async () => {
                  await api.post('/api/auth/logout', { provider: p.name });
                  toast(`Disconnected from ${p.name}`);
                  renderConnections();
                },
              }, 'Sign out'),
              el('button', { class: 'btn', onclick: () => switchView('explorer') }, 'Browse repos →'),
            ),
          )
        : el('div', { class: 'col' },
            p.oauthConfigured
              ? el('a', { href: `/auth/${p.name}/login`, class: 'btn btn-primary', style: 'text-align:center;text-decoration:none' }, `Sign in with OAuth`)
              : el('span', { class: 'muted', style: 'font-size:11.5px' },
                  `OAuth not configured (set ${p.name.toUpperCase()}_CLIENT_ID / _CLIENT_SECRET). Use a personal access token:`),
            el('div', { class: 'row' },
              patInput,
              el('button', { class: 'btn btn-primary', onclick: connectWithPat }, 'Connect'),
            ),
          ),
    );
  });
  $('conn-cards').replaceChildren(...cards);
}

function updateAuthButton() {
  const connected = authStatus?.providers.filter((p) => p.connected) || [];
  $('btn-auth').textContent = connected.length
    ? `👤 ${connected.map((p) => p.user?.login || p.name).join(', ')}`
    : '👤 Connect';
}
$('btn-auth').addEventListener('click', () => switchView('connections'));

/* ============================================================== refresh === */

async function refreshAll() {
  if (!repo) return;
  const [info, status, branches, history, graph] = await Promise.all([
    api.get('/api/repo/info'),
    api.get('/api/repo/status'),
    api.get('/api/repo/branches'),
    api.get('/api/repo/history?depth=80'),
    api.get('/api/repo/history?all=1&depth=100'),
  ]).catch(() => []);
  if (!info) return;
  repo = info;

  $('repo-chip').hidden = false;
  $('repo-name').textContent = `📂 ${info.name}`;
  $('branch-name').textContent = info.branch;

  renderChanges(status);
  renderMergeBanner(info.merge);
  renderBranches(branches);
  renderHistory(history);
  renderGraphTab(graph);
  setStatusMap(status.files);
  await refreshTree();
  refreshStash();
  refreshSync(false);
}

/* ============================================================== changes === */

function renderChanges(status) {
  const staged = status.files.filter((f) => f.stageStatus && !f.conflicted);
  const unstaged = status.files.filter((f) => (f.workStatus || f.conflicted));
  $('changes-count').textContent = status.files.length;

  const item = (f, isStaged) => {
    const st = f.conflicted ? 'conflicted' : (isStaged ? f.stageStatus : f.workStatus);
    const label = { modified: 'M', untracked: 'U', deleted: 'D', added: 'A', conflicted: '!' }[st] || '';
    return el('li', {},
      el('span', { class: `st st-${st}` }, label),
      el('span', {
        class: 'fname', title: f.filepath,
        onclick: () => f.conflicted ? openConflictEditor(f.filepath) : showDiff(f.filepath),
      }, f.filepath),
      el('span', { class: 'actions' },
        isStaged
          ? el('button', { class: 'btn btn-ghost btn-xs', title: 'Unstage', onclick: () => act('unstage', f.filepath) }, '−')
          : el('button', { class: 'btn btn-ghost btn-xs', title: 'Stage', onclick: () => act('stage', f.filepath) }, '＋'),
        !isStaged && el('button', {
          class: 'btn btn-ghost btn-xs', title: 'Discard changes',
          onclick: async () => {
            if (await confirmModal('Discard changes', `Local changes to ${f.filepath} will be lost. Are you sure?`)) {
              act('discard', f.filepath);
            }
          },
        }, '↺'),
      ),
    );
  };

  $('staged-list').replaceChildren(...staged.map((f) => item(f, true)));
  $('unstaged-list').replaceChildren(...unstaged.map((f) => item(f, false)));
}

async function act(action, path) {
  const ok = await withUi(api.post(`/api/repo/${action}`, { path }));
  if (ok !== null) refreshAll();
}
$('btn-stage-all').addEventListener('click', () => act('stage-all'));
$('btn-unstage-all').addEventListener('click', () => act('unstage-all'));

/* =============================================================== commit === */

async function loadAuthor() {
  try {
    const a = await api.get('/api/repo/author');
    if (a.name) $('commit-author').value = `${a.name} <${a.email}>`;
    const labels = {
      repo: '✓ this repo\'s own identity (.git/config)',
      github: '🐙 from your GitHub account — commit once to pin it to this repo',
      gitlab: '🦊 from your GitLab account — commit once to pin it to this repo',
      default: 'app default — commit once to pin it to this repo',
      none: '',
    };
    $('author-source').textContent = labels[a.source] ?? '';
  } catch { /* no repo */ }
}

function parseAuthor(text) {
  const m = text.match(/^(.*?)\s*<(.+)>$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : null;
}

async function doCommit() {
  const message = $('commit-msg').value.trim();
  if (!message) { $('commit-msg').focus(); return toast('Write a commit message', 'error'); }
  const author = parseAuthor($('commit-author').value.trim());
  const result = await withUi(
    api.post('/api/repo/commit', { message, author }),
    { loading: 'Committing…', success: 'Commit created ✔' },
  );
  if (result) { $('commit-msg').value = ''; refreshAll(); loadAuthor(); }
}
$('btn-commit').addEventListener('click', doCommit);

/* ================================================== push/pull/fetch/sync === */

let pullMode = localStorage.getItem('gitnd-pull-mode') || 'merge';

function applyPullModeUi() {
  $('btn-pull').childNodes[0].textContent = pullMode === 'rebase' ? '⇣ Pull (rebase)' : '⇣ Pull';
}

async function refreshSync(fetch) {
  if (!repo) return;
  const s = await api.get(`/api/repo/sync${fetch ? '?fetch=1' : ''}`)
    .catch((e) => { if (fetch) throw e; return null; }); // surface fetch failures (e.g. auth)
  if (!s) return;
  const badge = (id, n) => {
    $(id).hidden = !n;
    $(id).textContent = n;
  };
  badge('behind-badge', s.hasUpstream ? s.behind : 0);
  badge('ahead-badge', s.hasUpstream ? s.ahead : 0);
  if (fetch && s.hasUpstream) {
    toast(s.behind ? `${s.behind} incoming commit(s) to pull ⇣` : 'Remote checked: already up to date ✔',
      s.behind ? 'info' : 'success');
  }
  return s;
}

async function doPush() {
  const r = await withUi(api.post('/api/repo/push'), { loading: 'Pushing…', success: 'Push completed ⇡' });
  if (r) refreshAll();
}

async function doPull() {
  const r = await withUi(
    api.post('/api/repo/pull', { rebase: pullMode === 'rebase' }),
    { loading: pullMode === 'rebase' ? 'Pulling (rebase)…' : 'Pulling…' },
  );
  if (!r) return;
  if (r.conflicts?.length) {
    toast(`Conflicts in ${r.conflicts.length} file(s): resolve them to complete the merge`, 'error', 6000);
  } else if (r.upToDate) {
    toast(r.note || 'Already up to date ✔', 'success');
  } else if (r.rebased) {
    toast(r.fastForward ? 'Fast-forwarded to remote ✔' : `Rebased: ${r.replayed} commit(s) replayed on top ✔`, 'success');
  } else {
    toast('Pull completed ⇣', 'success');
  }
  refreshAll();
}

$('btn-push').addEventListener('click', doPush);
$('btn-pull').addEventListener('click', doPull);
$('btn-fetch').addEventListener('click', () => withUi(refreshSync(true), { loading: 'Fetching…' }));

$('btn-pull-mode').addEventListener('click', () => {
  const pick = (mode) => () => {
    pullMode = mode;
    localStorage.setItem('gitnd-pull-mode', mode);
    applyPullModeUi();
    closeModal();
  };
  openModal(
    el('h2', {}, 'Pull mode'),
    el('ul', { class: 'list-pick' },
      el('li', { onclick: pick('merge') },
        `${pullMode === 'merge' ? '✔' : '⇲'} Merge`,
        el('span', { class: 'muted', style: 'margin-left:auto' }, 'creates a merge commit when branches diverge')),
      el('li', { onclick: pick('rebase') },
        `${pullMode === 'rebase' ? '✔' : '⇱'} Rebase`,
        el('span', { class: 'muted', style: 'margin-left:auto' }, 'replays your commits on top — linear history')),
    ),
  );
});

// Check the remote every 2 minutes so the Pull badge stays honest.
setInterval(() => { if (repo) refreshSync(true).catch(() => {}); }, 120000);

/* ============================================================== history === */

function renderHistory(commits) {
  $('commit-list').replaceChildren(...commits.slice(0, 30).map((c) =>
    el('li', { onclick: () => commitActions(c) },
      el('div', { class: 'cmsg' }, c.message.split('\n')[0]),
      el('div', { class: 'cmeta' },
        el('span', { class: 'chash' }, c.oid.slice(0, 7)),
        el('span', {}, c.author),
        el('span', {}, new Date(c.date).toLocaleString()),
      ),
    )));
}

function renderGraphTab(graph) {
  const { commits = [], tips = {}, headOid = null } = graph || {};
  $('graph-wrap').replaceChildren(
    commits.length
      ? renderGraph(commits, { onSelect: commitActions, tips, headOid })
      : el('p', { class: 'muted' }, 'No commits.'),
  );
}

async function commitActions(c) {
  const detail = await withUi(api.get(`/api/repo/commit?oid=${c.oid}`), { loading: 'Loading commit…' });
  if (!detail) return;
  const typeLabel = { add: 'A', del: 'D', mod: 'M' };
  const typeClass = { add: 'untracked', del: 'deleted', mod: 'modified' };
  openModal(
    el('h2', {}, c.message.split('\n')[0]),
    el('p', { class: 'muted' }, `${c.oid} · ${c.author} · ${new Date(c.date).toLocaleString()}`),
    el('div', { class: 'subsection-title' }, `Changed files (${detail.files.length}) — click one to see the lines`),
    el('ul', { class: 'file-list', style: 'max-height:32vh;overflow:auto' },
      detail.files.map((f) => el('li', { onclick: () => { closeModal(); showDiff(f.filepath, c.oid); } },
        el('span', { class: `st st-${typeClass[f.type]}` }, typeLabel[f.type]),
        el('span', { class: 'fname', title: f.filepath }, f.filepath),
      ))),
    el('div', { class: 'modal-actions' },
      el('button', {
        class: 'btn btn-danger',
        onclick: async () => {
          closeModal();
          if (await confirmModal('Revert to this commit',
            `The current branch will point to ${c.oid.slice(0, 7)} and the working directory will be restored (hard reset). Later commits are dropped from the branch. Are you sure?`)) {
            const r = await withUi(api.post('/api/repo/reset', { oid: c.oid }), { loading: 'Resetting…', success: 'Branch reset' });
            if (r) refreshAll();
          }
        },
      }, '⏪ Revert to this commit'),
      el('button', { class: 'btn', onclick: closeModal }, 'Close'),
    ),
  );
}

/* ============================================================= branches === */

function renderBranches(branches) {
  const li = (name, isCurrent, isRemote) => el('li', {},
    el('span', { class: `bname ${isCurrent ? 'current' : ''}` }, `${isCurrent ? '✔ ' : ''}⎇ ${name}`),
    !isCurrent && !isRemote && el('span', { class: 'actions row' },
      el('button', {
        class: 'btn btn-ghost btn-xs', title: 'Switch to this branch',
        onclick: () => switchBranch(name),
      }, '→'),
      el('button', {
        class: 'btn btn-ghost btn-xs', title: 'Delete',
        onclick: async () => {
          if (await confirmModal('Delete branch', `Delete branch ${name}?`)) {
            const r = await withUi(api.post('/api/repo/branch/delete', { name }));
            if (r) refreshAll();
          }
        },
      }, '🗑'),
    ),
    !isCurrent && isRemote && el('span', { class: 'actions row' },
      el('button', {
        class: 'btn btn-ghost btn-xs', title: 'Checkout: create/switch to the matching local branch',
        onclick: () => switchBranch(name),
      }, '→'),
      el('button', {
        class: 'btn btn-ghost btn-xs', title: 'Merge into current branch',
        onclick: () => mergeBranch(name),
      }, '⇲ merge'),
    ),
  );
  $('branch-list').replaceChildren(
    ...branches.local.map((b) => li(b, b === branches.current, false)),
    ...branches.remote.map((b) => li(b, false, true)),
  );
}

async function switchBranch(name) {
  const r = await withUi(api.post('/api/repo/branch/switch', { name }));
  if (!r) return;
  toast(r.created
    ? `Created local branch ${r.branch} from ${r.tracking} ✔`
    : `Branch: ${r.branch}`, 'success');
  refreshAll();
}

async function mergeBranch(theirRef) {
  const author = parseAuthor($('commit-author').value.trim());
  const r = await withUi(api.post('/api/repo/merge', { theirRef, author }), { loading: `Merging ${theirRef}…` });
  if (!r) return;
  if (r.conflicts?.length) toast(`Conflicts in ${r.conflicts.length} file(s)`, 'error', 6000);
  else toast('Merge completed ✔', 'success');
  refreshAll();
}

$('btn-new-branch').addEventListener('click', async () => {
  const name = $('new-branch').value.trim();
  if (!name) return;
  const r = await withUi(api.post('/api/repo/branch/create', { name }), { success: `Branch created: ${name}` });
  if (r) { $('new-branch').value = ''; refreshAll(); }
});

$('btn-branch').addEventListener('click', async () => {
  const branches = await api.get('/api/repo/branches').catch(() => null);
  if (!branches) return;
  openModal(
    el('h2', {}, 'Switch branch'),
    el('ul', { class: 'list-pick' },
      branches.local.map((b) =>
        el('li', { onclick: () => { closeModal(); if (b !== branches.current) switchBranch(b); } },
          b === branches.current ? `✔ ${b}` : `⎇ ${b}`)),
      branches.remote.map((b) =>
        el('li', { onclick: () => { closeModal(); switchBranch(b); } },
          `☁ ${b}`, el('span', { class: 'muted', style: 'margin-left:auto' }, 'checkout'))),
    ),
  );
});

/* ============================================================ conflicts === */

function renderMergeBanner(merge) {
  const banner = $('merge-banner');
  banner.hidden = !merge;
  if (!merge) return;
  $('merge-files').replaceChildren(...merge.files.map((f) => {
    const resolved = merge.resolved.includes(f);
    return el('div', {
      class: `conflict-file ${resolved ? 'resolved' : ''}`,
      onclick: () => !resolved && openConflictEditor(f),
    }, `${resolved ? '✔' : '⚠'} ${f}`);
  }));
}

let conflictFile = null;

async function openConflictEditor(path) {
  const file = await withUi(api.get(`/api/repo/file?path=${encodeURIComponent(path)}`));
  if (!file) return;
  conflictFile = path;
  $('conflict-path').textContent = path;
  $('conflict-editor').value = file.content || '';
  showTab('conflict');
}

function pickSide(text, side) {
  const out = [];
  let state = 'normal';
  for (const line of text.split('\n')) {
    if (line.startsWith('<<<<<<<')) state = 'ours';
    else if (line.startsWith('=======') && state === 'ours') state = 'theirs';
    else if (line.startsWith('>>>>>>>')) state = 'normal';
    else if (state === 'normal' || state === side) out.push(line);
  }
  return out.join('\n');
}

$('c-ours').addEventListener('click', () => {
  $('conflict-editor').value = pickSide($('conflict-editor').value, 'ours');
});
$('c-theirs').addEventListener('click', () => {
  $('conflict-editor').value = pickSide($('conflict-editor').value, 'theirs');
});
$('c-save').addEventListener('click', async () => {
  if (!conflictFile) return;
  const content = $('conflict-editor').value;
  if (/^(<{7}|={7}|>{7})/m.test(content)) {
    return toast('There are still conflict markers left (<<<<<<< ======= >>>>>>>)', 'error');
  }
  const saved = await withUi(api.post('/api/repo/file', { path: conflictFile, content }));
  if (saved === null) return;
  const staged = await withUi(api.post('/api/repo/stage', { path: conflictFile }), { success: `Resolved: ${conflictFile}` });
  if (staged !== null) refreshAll();
});

$('btn-merge-done').addEventListener('click', async () => {
  const author = parseAuthor($('commit-author').value.trim());
  const r = await withUi(
    api.post('/api/repo/commit', { message: $('commit-msg').value.trim() || undefined, author }),
    { loading: 'Completing merge…', success: 'Merge completed ✔' },
  );
  if (r) { $('commit-msg').value = ''; refreshAll(); }
});

$('btn-merge-abort').addEventListener('click', async () => {
  if (await confirmModal('Abort merge', 'Resolutions made so far will be discarded. Are you sure?')) {
    const r = await withUi(api.post('/api/repo/merge/abort'), { success: 'Merge aborted' });
    if (r) refreshAll();
  }
});

/* ================================================================ stash === */

async function refreshStash() {
  try {
    const { list } = await api.get('/api/repo/stash');
    const items = Array.isArray(list) ? list : [];
    $('stash-list').replaceChildren(...items.map((s) =>
      el('li', {}, typeof s === 'string' ? s : JSON.stringify(s))));
  } catch { /* stash unsupported */ }
}

const stashOp = (op) => async () => {
  const r = await withUi(api.post('/api/repo/stash', { op }), { success: `Stash: ${op} ✔` });
  if (r) refreshAll();
};
$('btn-stash-push').addEventListener('click', stashOp('push'));
$('btn-stash-apply').addEventListener('click', stashOp('apply'));
$('btn-stash-pop').addEventListener('click', stashOp('pop'));

/* ========================================================== file editor === */

let currentFile = null;
let fileDirty = false;

function setDirty(dirty) {
  fileDirty = dirty;
  $('file-dirty').textContent = dirty ? '● unsaved' : '';
}

async function openFile(path) {
  const file = await withUi(api.get(`/api/repo/file?path=${encodeURIComponent(path)}`));
  if (!file) return;
  const editor = $('file-editor');
  currentFile = file.binary ? null : path;
  $('file-path').textContent = path;
  editor.value = file.binary ? `(binary file, ${file.size} bytes)` : file.content;
  editor.readOnly = file.binary;
  $('btn-save-file').disabled = file.binary;
  setDirty(false);
  showTab('file');
}
setOpenFileHandler(openFile);

async function saveFile() {
  if (!currentFile || !fileDirty) return;
  const r = await withUi(
    api.post('/api/repo/file', { path: currentFile, content: $('file-editor').value }),
    { success: `Saved: ${currentFile}` },
  );
  if (r !== null) { setDirty(false); refreshAll(); }
}

$('file-editor').addEventListener('input', () => setDirty(true));
$('btn-save-file').addEventListener('click', saveFile);

async function showDiff(path, oid) {
  const q = oid ? `&oid=${oid}` : '';
  const diff = await withUi(api.get(`/api/repo/diff?file=${encodeURIComponent(path)}${q}`));
  if (!diff) return;
  $('diff-path').textContent = oid ? `${path} @ ${oid.slice(0, 7)}` : path;
  $('diff-view').replaceChildren(renderDiff(diff.rows));
  showTab('diff');
}

/* =========================================================== open/clone === */

async function openRepo(dir) {
  const info = await withUi(api.post('/api/repo/open', { dir }), { loading: 'Opening repository…' });
  if (!info) return;
  repo = info;
  addRecent(info.dir);
  closeModal();
  toast(`Repository opened: ${info.name}`, 'success');
  loadAuthor();
  refreshAll();
  switchView('repo');
  showTab('graph');
}

function cloneModal(prefillUrl = '') {
  const url = el('input', { type: 'text', placeholder: 'https://github.com/user/repo.git', value: prefillUrl });
  const dest = el('input', { type: 'text', placeholder: '(optional) target directory' });
  const go = async () => {
    if (!url.value.trim()) return;
    const info = await withUi(
      api.post('/api/repo/clone', { url: url.value.trim(), dir: dest.value.trim() || undefined }),
      { loading: 'Cloning… this may take a while', success: 'Repository cloned ✔' },
    );
    if (info) {
      repo = info;
      addRecent(info.dir);
      closeModal();
      loadAuthor();
      refreshAll();
      switchView('repo');
      showTab('graph');
    }
  };
  openModal(
    el('h2', {}, '⬇ Clone repository'),
    el('div', {}, el('label', {}, 'URL'), url),
    el('div', {}, el('label', {}, 'Target'), dest),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      el('button', { class: 'btn btn-primary', onclick: go }, 'Clone'),
    ),
  );
}

$('btn-clone').addEventListener('click', () => cloneModal());
$('repo-name').addEventListener('click', () => switchView('explorer'));
$('btn-refresh-tree').addEventListener('click', refreshAll);

/* ========================================================== PR / issues === */

function originRepoSlug() {
  const origin = repo?.remotes?.find((r) => r.remote === 'origin')?.url || '';
  const m = origin.match(/[:/]([^/:]+\/[^/]+?)(\.git)?$/);
  return m ? m[1] : '';
}

function providerFromOrigin() {
  const origin = repo?.remotes?.find((r) => r.remote === 'origin')?.url || '';
  return origin.includes('gitlab') ? 'gitlab' : 'github';
}

$('btn-create-pr').addEventListener('click', () => {
  if (!repo) return toast('Open a repository first', 'error');
  const slug = el('input', { type: 'text', value: originRepoSlug(), placeholder: 'owner/repo' });
  const title = el('input', { type: 'text', placeholder: 'PR title' });
  const body = el('textarea', { placeholder: 'Description (optional)' });
  const source = el('input', { type: 'text', value: repo.branch });
  const target = el('input', { type: 'text', value: 'main' });
  openModal(
    el('h2', {}, '⇄ Create Pull Request / Merge Request'),
    el('div', {}, el('label', {}, 'Repository'), slug),
    el('div', {}, el('label', {}, 'Title'), title),
    el('div', {}, el('label', {}, 'Description'), body),
    el('div', { class: 'row' },
      el('div', { style: 'flex:1' }, el('label', {}, 'From (source)'), source),
      el('div', { style: 'flex:1' }, el('label', {}, 'Into (target)'), target),
    ),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          const r = await withUi(api.post('/api/providers/pr', {
            provider: providerFromOrigin(), repo: slug.value.trim(),
            title: title.value.trim(), body: body.value,
            sourceBranch: source.value.trim(), targetBranch: target.value.trim(),
          }), { loading: 'Creating PR…' });
          if (r) { closeModal(); toast(`PR #${r.number} created ✔`, 'success', 6000); window.open(r.url, '_blank'); }
        },
      }, 'Create'),
    ),
  );
});

$('btn-issues').addEventListener('click', async () => {
  if (!repo) return toast('Open a repository first', 'error');
  const provider = providerFromOrigin();
  const slug = originRepoSlug();
  const data = await withUi(api.get(`/api/providers/issues?provider=${provider}&repo=${encodeURIComponent(slug)}`), { loading: 'Loading issues…' });
  if (!data) return;
  const title = el('input', { type: 'text', placeholder: 'New issue title' });
  openModal(
    el('h2', {}, `🐛 Issues for ${slug}`),
    el('ul', { class: 'list-pick' },
      data.issues.length
        ? data.issues.map((i) => el('li', { onclick: () => window.open(i.url, '_blank') },
            el('span', {}, `#${i.number}`), el('span', {}, i.title),
            el('span', { class: 'muted', style: 'margin-left:auto' }, i.author)))
        : el('li', { class: 'muted' }, 'No open issues.')),
    el('div', { class: 'row' },
      title,
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!title.value.trim()) return;
          const r = await withUi(api.post('/api/providers/issues', { provider, repo: slug, title: title.value.trim() }), { loading: 'Creating issue…' });
          if (r) { closeModal(); toast(`Issue #${r.number} created ✔`, 'success'); }
        },
      }, 'Create'),
    ),
  );
});

/* =========================================================== quick open === */

async function quickOpen() {
  if (!repo) return;
  const files = await api.get('/api/repo/files').catch(() => []);
  const input = el('input', { type: 'text', placeholder: 'Go to file…' });
  const list = el('ul', { class: 'list-pick' });
  let matches = files;
  const render = () => {
    matches = files.filter((f) => f.toLowerCase().includes(input.value.toLowerCase())).slice(0, 50);
    list.replaceChildren(...matches.map((f, i) =>
      el('li', { class: i === 0 ? 'active' : '', onclick: () => { closeModal(); openFile(f); } },
        el('span', {}, fileIcon(f.split('/').pop(), 'file')), f)));
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && matches[0]) { closeModal(); openFile(matches[0]); }
  });
  render();
  openModal(input, list);
}

/* ======================================================= keyboard/theme === */

document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (!mod) return;
  if (e.key === 's' && !e.shiftKey) {
    e.preventDefault();
    // Context-aware: on the File tab Ctrl+S saves the file, elsewhere it commits.
    if (activeTab() === 'file' && currentFile) saveFile();
    else doCommit();
  } else if (e.key.toLowerCase() === 'p' && e.shiftKey) { e.preventDefault(); doPush(); }
  else if (e.key === 'p') { e.preventDefault(); quickOpen(); }
});

$('btn-theme').addEventListener('click', () => {
  const html = document.documentElement;
  const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
  html.dataset.theme = next;
  localStorage.setItem('gitnd-theme', next);
  $('btn-theme').textContent = next === 'dark' ? '🌙' : '☀️';
});
document.documentElement.dataset.theme = localStorage.getItem('gitnd-theme') || 'dark';

/* =============================================================== events === */

onEvent('file-changed', () => refreshAll());

/* ================================================================= boot === */

(async function boot() {
  initTreeDnD();
  applyPullModeUi();
  authStatus = await api.get('/api/auth/status').catch(() => null);
  updateAuthButton();
  try {
    repo = await api.get('/api/repo/info');
    loadAuthor();
    refreshAll();
    switchView('repo');
  } catch {
    switchView('explorer'); // nothing open → start where you pick a repo
  }
})();

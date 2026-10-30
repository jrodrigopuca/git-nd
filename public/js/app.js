import { api, withUi, onEvent } from './api.js';
import { el, icon, toast, openModal, closeModal, confirmModal, fileIcon, setChildren, makeActivatable, friendlyDate, fullDate } from './ui.js';
import { refreshTree, setStatusMap, setOpenFileHandler, initTreeDnD } from './tree.js';
import { renderDiff } from './diff.js';
import { GraphView } from './graph.js';
import { parseConflicts, assembleConflicts, renderConflictUI } from './conflict.js';

const $ = (id) => document.getElementById(id);
let repo = null;       // current repo info
let authStatus = null; // provider connection status

/* ================================================================ views === */

function switchView(name) {
  document.querySelectorAll('.act-btn').forEach((b) => {
    const current = b.dataset.view === name;
    b.classList.toggle('active', current);
    if (current) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
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
  // On the merge view itself the banner is just status: no button to the place you are.
  document.getElementById('btn-merge-view').hidden = name === 'merge';
}
document.querySelectorAll('.tab').forEach((t) =>
  t.addEventListener('click', () => showTab(t.dataset.tab)));

/* ======================================================= right-panel drawer === */
/* Narrow windows (≤980px): the right panel — Changes, staging, commit — is a
   drawer opened from the top bar instead of disappearing (visual review V-E).
   CSS does the layout; this keeps state, focus and closing in line. */

const narrowMq = window.matchMedia('(max-width: 980px)');
const panelOpen = () => $('rightbar').classList.contains('open');

function setPanel(open) {
  $('rightbar').classList.toggle('open', open);
  $('btn-panel').setAttribute('aria-expanded', String(open));
  $('drawer-scrim').hidden = !open;
  if (open) {
    $('btn-panel-close').focus(); // focus moves into the panel
  } else if ($('rightbar').contains(document.activeElement) && narrowMq.matches) {
    $('btn-panel').focus(); // …and back to what opened it
  }
}

$('btn-panel').addEventListener('click', () => setPanel(!panelOpen()));
$('btn-panel-close').addEventListener('click', () => setPanel(false));
$('drawer-scrim').addEventListener('click', () => setPanel(false));
document.addEventListener('keydown', (e) => {
  // Esc closes the drawer — unless a modal is open (Esc belongs to the modal then).
  if (e.key === 'Escape' && panelOpen() && narrowMq.matches && $('modal-backdrop').hidden) setPanel(false);
});
// Widening the window turns the drawer back into the normal column: drop the
// open state — without the slide-out animation, which would otherwise play
// across the breakpoint while the window is being resized.
narrowMq.addEventListener('change', () => {
  if (!panelOpen()) return;
  $('rightbar').classList.add('no-anim');
  setPanel(false);
  requestAnimationFrame(() => requestAnimationFrame(() => $('rightbar').classList.remove('no-anim')));
});

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
      el('li', { onclick: () => openRepo(dir) }, icon('folder-git-2'), dir)),
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
          `Open this repository (${data.path.split('/').pop()})`)
      : '',
  );
  $('ex-dirs').replaceChildren(...data.entries.map((e) =>
    el('li', { onclick: () => (e.isRepo ? openRepo(e.path) : browseTo(e.path)) },
      icon(e.isRepo ? 'folder-git-2' : 'folder'), e.name,
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
        r.private ? icon('lock', { label: 'Private' }) : null, r.fullName,
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
  $('conn-cards').replaceChildren(...(authStatus?.providers || []).map(connectionCard));
}

const PROVIDER_LABEL = { github: 'GitHub', gitlab: 'GitLab' };

/**
 * One provider (visual review 2, R2-6): name + state in the header; connected
 * → who you are, Browse, Disconnect; not connected → a labelled token field
 * with show/hide, the scopes it needs and where to create it, and the error
 * NEXT TO the field (a toast alone vanished). With OAuth configured, one-click
 * sign-in is the primary and the token is the folded alternative.
 */
function connectionCard(p) {
  const label = PROVIDER_LABEL[p.name] || p.name;
  const state = p.connected
    ? el('span', { class: 'conn-state ok' }, icon('circle-check'), 'Connected')
    : el('span', { class: 'conn-state' }, 'Not connected');
  const head = el('div', { class: 'conn-head' },
    el('h2', {}, icon(p.name in PROVIDER_LABEL ? p.name : 'plug'), ` ${label}`), state);

  if (p.connected) {
    const u = p.user || {};
    return el('section', { class: 'conn-card', 'data-provider': p.name, 'aria-label': label },
      head,
      el('div', { class: 'conn-user' },
        u.avatar ? el('img', { class: 'avatar', src: u.avatar, alt: '' }) : el('span', { class: 'avatar avatar-empty' }, icon('circle-user-round')),
        el('div', {},
          el('div', { class: 'conn-name' }, u.name || u.login || label),
          el('div', { class: 'muted conn-sub' }, [u.login && `@${u.login}`, u.email].filter(Boolean).join(' · '))),
      ),
      el('div', { class: 'row conn-actions' },
        el('button', { class: 'btn', onclick: () => switchView('explorer') }, 'Browse repositories', icon('arrow-right', { className: 'icon-after' })),
        el('button', {
          class: 'btn btn-ghost push-end', onclick: async () => {
            await api.post('/api/auth/logout', { provider: p.name }).catch((e) => toast(e.message, 'error'));
            toast(`Disconnected from ${label}`);
            renderConnections();
          },
        }, 'Disconnect'),
      ),
    );
  }

  const tokenForm = patForm(p, label, { primary: !p.oauthConfigured });
  const body = p.oauthConfigured
    ? [
        el('a', { href: `/auth/${p.name}/login`, class: 'btn btn-primary conn-oauth' }, `Sign in with ${label}`),
        el('details', { class: 'conn-alt' }, el('summary', {}, 'Use a personal access token instead'), tokenForm),
      ]
    : [
        tokenForm,
        el('details', { class: 'conn-alt' },
          el('summary', {}, 'Prefer one-click sign-in?'),
          el('p', { class: 'muted conn-help' },
            `Register an OAuth app and start git-nd with ${p.name.toUpperCase()}_CLIENT_ID and ${p.name.toUpperCase()}_CLIENT_SECRET set; a "Sign in with ${label}" button appears here.`)),
      ];
  return el('section', { class: 'conn-card', 'data-provider': p.name, 'aria-label': label }, head, ...body);
}

/** The personal-access-token form: label, show/hide, scopes + link, inline error. */
function patForm(p, label, { primary }) {
  const id = `pat-${p.name}`;
  const helpId = `${id}-help`;
  const errId = `${id}-error`;
  const input = el('input', { type: 'password', id, autocomplete: 'off', spellcheck: 'false', 'aria-describedby': helpId });
  const eye = el('button', { type: 'button', class: 'btn btn-ghost btn-icon conn-eye', 'aria-label': 'Show token', 'aria-pressed': 'false', title: 'Show token' }, icon('eye'));
  eye.addEventListener('click', () => {
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', String(show));
    eye.replaceChildren(icon(show ? 'eye-off' : 'eye'));
  });
  const connect = el('button', { type: 'submit', class: `btn ${primary ? 'btn-primary' : ''}` }, 'Connect');
  const error = el('p', { class: 'conn-error', id: errId, hidden: true });
  const setError = (msg) => {
    error.hidden = !msg;
    error.replaceChildren(...(msg ? [icon('triangle-alert'), ` ${msg}`] : []));
    if (msg) {
      input.setAttribute('aria-invalid', 'true');
      input.setAttribute('aria-describedby', `${errId} ${helpId}`);
    } else {
      input.removeAttribute('aria-invalid');
      input.setAttribute('aria-describedby', helpId);
    }
  };
  input.addEventListener('input', () => { if (!error.hidden) setError(''); });

  const scopes = p.token?.scopes || [];
  const help = el('p', { class: 'muted conn-help', id: helpId },
    scopes.length ? ['Needs the ', ...scopes.flatMap((s, i) => [i ? ' and ' : '', el('code', {}, s)]), ' scopes. '] : '',
    p.token?.createUrl && el('a', { href: p.token.createUrl, target: '_blank', rel: 'noopener noreferrer' },
      `Create a token on ${label}`, icon('external-link', { className: 'icon-after' })));

  const form = el('form', { class: 'conn-form', novalidate: true },
    el('label', { for: id }, 'Personal access token'),
    el('div', { class: 'conn-field' }, input, eye, connect),
    error,
    help,
  );
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = input.value.trim();
    if (!token) { setError('Paste a token first.'); input.focus(); return; }
    setError('');
    input.disabled = true;
    connect.disabled = true;
    connect.textContent = 'Checking…';
    form.setAttribute('aria-busy', 'true');
    try {
      const r = await api.post('/api/auth/token', { provider: p.name, token });
      toast(`Connected to ${label} as ${r.user.login}`, 'success');
      renderConnections();
    } catch (err) {
      input.disabled = false;
      connect.disabled = false;
      connect.textContent = 'Connect';
      form.removeAttribute('aria-busy');
      setError(err.status === 401 || err.status === 403 ? `${label} rejected this token: ${err.message}` : err.message);
      input.focus();
    }
  });
  return form;
}

function updateAuthButton() {
  const connected = authStatus?.providers.filter((p) => p.connected) || [];
  $('auth-label').textContent = connected.length
    ? connected.map((p) => p.user?.login || p.name).join(', ')
    : 'Connect';
}
$('btn-auth').addEventListener('click', () => switchView('connections'));

/* ============================================================== refresh === */

// Each refreshAll takes a number; a response that comes back after a NEWER
// refresh started is dropped whole. The newer one reflects later state no
// matter which lands first. Without it, a watcher refresh issued before a
// commit but answered after the commit's own refresh repainted the old
// changes list and branches (BACKLOG B-18).
let refreshSeq = 0;

async function refreshAll({ loading = false } = {}) {
  if (!repo) return;
  const mySeq = ++refreshSeq;
  const graphEpoch = graph.epoch; // the graph state this refresh's page request is based on
  // allSettled, not all: one failing panel must not leave the whole screen on
  // the PREVIOUS repo, with buttons that act on the new one (BACKLOG B-08).
  const call = Promise.allSettled([
    api.get('/api/repo/info'),
    api.get('/api/repo/status'),
    api.get('/api/repo/branches'),
    api.get('/api/repo/history?depth=80'),
    api.get(graphRequestUrl()),
  ]);
  // Only the initial open / boot shows the fullscreen spinner and surfaces
  // errors. Background refreshes (watcher, post commit/push/stash) stay silent
  // to avoid covering the screen and clobbering another operation's spinner.
  const settled = loading ? await withUi(call, { loading: 'Loading repository…' }) : await call;
  if (!settled || mySeq !== refreshSeq) return; // superseded by a newer refresh
  const [infoR, statusR, branchesR, historyR, graphR] = settled;
  const failed = settled.filter((r) => r.status === 'rejected');
  if (loading && failed.length) toast(`Some panels could not load: ${failed[0].reason.message}`, 'error');
  if (infoR.status === 'rejected') return; // without info we cannot know which repo this is
  const info = infoR.value;
  if (repo?.dir && info.dir !== repo.dir && !switchingRepo) {
    // The server's repo was switched from outside this tab (another tab, a
    // script): every view bound to a path of the old repo must go, or its
    // buttons act on the new one (BACKLOG B-04, reopened).
    const lost = fileDirty ? currentFile : null;
    closeRepoViews();
    toast(`Repository switched to ${info.name} from another window${lost ? ` — unsaved changes to ${lost} were discarded` : ''}`,
      lost ? 'error' : 'info', 7000);
  }
  // A failed panel shows as empty: never as another repo's content.
  const status = statusR.status === 'fulfilled' ? statusR.value : { branch: info.branch, merge: info.merge, files: [] };
  const branches = branchesR.status === 'fulfilled' ? branchesR.value : { current: info.branch, local: [], remote: [] };
  const history = historyR.status === 'fulfilled' ? historyR.value : [];
  const graphPage = graphR.status === 'fulfilled' ? graphR.value : null;
  if (!graphPage && graph.dir !== info.dir) {
    graph.view?.destroy();
    Object.assign(graph, { dir: info.dir, walkId: null, view: null, loaded: 0, done: true });
    graph.epoch++;
    $('graph-wrap').replaceChildren(el('p', { class: 'muted pad' }, 'Could not load the graph.'));
  }
  repo = info;

  $('repo-chip').hidden = false;
  $('repo-name').replaceChildren(icon('folder-git-2'), info.name);
  // Full path on hover: after a clone or open, "where is this repo?" is one hover away.
  $('repo-name').title = `${info.dir}\nClick to switch repository (Explorer)`;
  $('branch-name').textContent = info.branch;

  renderChanges(status);
  renderMergeBanner(info.merge);
  renderBranches(branches);
  renderHistory(history);
  renderGraphTab(graphPage, graphEpoch);
  setStatusMap(status.files);
  await refreshTree();
  if (mySeq !== refreshSeq) return; // a newer refresh will do stash/sync
  refreshStash();
  refreshSync(false);
}

/* ============================================================== changes === */

function renderChanges(status) {
  const staged = status.files.filter((f) => f.stageStatus && !f.conflicted);
  const unstaged = status.files.filter((f) => (f.workStatus || f.conflicted));
  $('changes-count').textContent = status.files.length;
  $('staged-count').textContent = staged.length;
  $('unstaged-count').textContent = unstaged.length;
  $('staged-empty').hidden = staged.length > 0;
  stagedCount = staged.length;
  updateCommitButton();
  // Same count on the narrow-window "Changes" button (the panel is a drawer there).
  $('panel-badge').textContent = status.files.length;
  $('panel-badge').hidden = status.files.length === 0;

  const item = (f, isStaged) => {
    const st = f.conflicted ? 'conflicted' : (isStaged ? f.stageStatus : f.workStatus);
    const label = { modified: 'M', untracked: 'U', deleted: 'D', added: 'A', conflicted: '!' }[st] || '';
    // Keyboard-operable row (BACKLOG B-23): the file name is a real <button>
    // (it was a clickable <span>, unreachable with Tab), and every button has
    // an aria-label naming its file — the visible text is just a symbol.
    return el('li', {},
      el('span', { class: `st st-${st}`, 'aria-hidden': 'true' }, label),
      el('button', {
        type: 'button', class: 'fname', title: f.filepath,
        'aria-label': f.conflicted ? `Resolve conflict in ${f.filepath}`
          : `Show ${isStaged ? 'staged' : 'unstaged'} changes in ${f.filepath}`,
        onclick: () => f.conflicted ? openConflictEditor(f.filepath) : showWorkdirDiff(f.filepath, isStaged),
      }, f.filepath),
      el('span', { class: 'actions' },
        isStaged
          ? el('button', { class: 'btn btn-ghost btn-xs btn-icon', title: 'Unstage', 'aria-label': `Unstage ${f.filepath}`, onclick: () => act('unstage', f.filepath) }, icon('minus'))
          : el('button', { class: 'btn btn-ghost btn-xs btn-icon', title: 'Stage', 'aria-label': `Stage ${f.filepath}`, onclick: () => act('stage', f.filepath) }, icon('plus')),
        !isStaged && el('button', {
          class: 'btn btn-ghost btn-xs btn-icon', title: 'Discard changes', 'aria-label': `Discard changes to ${f.filepath}`,
          onclick: async () => {
            if (await confirmModal('Discard changes', `Local changes to ${f.filepath} will be lost. Are you sure?`)) {
              act('discard', f.filepath);
            }
          },
        }, icon('undo-2')),
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
      repo: '· this repo\'s identity',
      github: '· from your GitHub account',
      gitlab: '· from your GitLab account',
      default: '· app default',
      none: '',
    };
    $('author-source').textContent = labels[a.source] ?? '';
    // No author anywhere: the field is needed, so show it right away.
    if (!a.name) showAuthorField(true);
    renderAuthorLine();
  } catch { /* no repo */ }
}

/* Author as a line ("Ana <ana@x.io> · this repo's identity · change"), not a
   field that reads like a required first step (visual review V-B). The input
   stays in the DOM, revealed by "change". */
function renderAuthorLine() {
  const text = $('commit-author').value.trim();
  $('author-display').textContent = text || 'No author set — enter one below';
}
function showAuthorField(show) {
  $('commit-author').hidden = !show;
  $('btn-author-change').setAttribute('aria-expanded', String(show));
  $('btn-author-change').textContent = show ? 'done' : 'change';
}
$('btn-author-change').addEventListener('click', () => {
  const show = $('commit-author').hidden;
  showAuthorField(show);
  if (show) $('commit-author').focus();
});
$('commit-author').addEventListener('input', renderAuthorLine);

function parseAuthor(text) {
  const m = text.match(/^(.*?)\s*<(.+)>$/);
  return m ? { name: m[1].trim(), email: m[2].trim() } : null;
}

async function doCommit() {
  // Ctrl+S obeys the same rule as the button: if it cannot commit, say why.
  if ($('btn-commit').disabled) return toast($('commit-reason').textContent || 'Nothing to commit', 'error');
  const message = $('commit-msg').value.trim();
  const amend = $('amend-check').checked;
  // A merge commit may go without a message: the server uses "Merge <ref>".
  if (!message && !amend && !repo?.merge) { $('commit-msg').focus(); return toast('Write a commit message', 'error'); }
  const author = parseAuthor($('commit-author').value.trim());
  const result = await withUi(
    api.post(amend ? '/api/repo/amend' : '/api/repo/commit', { message, author }),
    { loading: amend ? 'Amending…' : 'Committing…', success: amend ? 'Commit amended' : 'Commit created' },
  );
  if (result) {
    $('commit-msg').value = '';
    $('amend-check').checked = false;
    updateCommitButton();
    refreshAll();
    loadAuthor();
  }
}
$('btn-commit').addEventListener('click', doCommit);

let stagedCount = 0;

/**
 * The commit button says what it will do — or is disabled with the reason
 * next to it (aria-describedby="commit-reason"). One rule for the button
 * AND Ctrl+S (visual review V-B).
 */
function updateCommitButton() {
  const btn = $('btn-commit');
  const merge = repo?.merge;
  const pending = merge ? merge.files.filter((f) => !merge.resolved.includes(f)).length : 0;
  let label;
  let why = '';
  if ($('amend-check').checked) {
    // The primary button's text says what it does; no icon (proposal F4).
    label = 'Amend last commit'; // may change just the message: nothing staged is fine
  } else if (merge) {
    label = 'Complete merge';
    if (pending) why = `Resolve ${pending} conflicted file${pending === 1 ? '' : 's'} first.`;
  } else if (!stagedCount) {
    label = 'Commit';
    why = 'Stage at least one file to commit.';
  } else {
    label = `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'} to ${repo?.branch || 'HEAD'}`;
  }
  btn.textContent = label;
  btn.disabled = Boolean(why);
  $('commit-reason').textContent = why;
}
$('amend-check').addEventListener('change', async () => {
  updateCommitButton();
  // Prefill the last message so amending keeps it by default.
  if ($('amend-check').checked && !$('commit-msg').value.trim()) {
    const last = await api.get('/api/repo/history?depth=1').catch(() => null);
    if (last?.[0]) $('commit-msg').value = last[0].message;
  }
});

/* ================================================== push/pull/fetch/sync === */

let pullMode = localStorage.getItem('gitnd-pull-mode') || 'merge';

function applyPullModeUi() {
  $('pull-label').textContent = pullMode === 'rebase' ? 'Pull (rebase)' : 'Pull';
}

async function refreshSync(fetch) {
  if (!repo) return;
  const badge = (id, n) => {
    $(id).hidden = !n;
    $(id).textContent = n;
  };
  let s;
  try {
    s = await (fetch ? api.post('/api/repo/sync/fetch') : api.get('/api/repo/sync'));
  } catch (e) {
    // Unknown state: clear the badges rather than keep the previous repo's
    // numbers on screen (BACKLOG B-21).
    badge('behind-badge', 0);
    badge('ahead-badge', 0);
    if (fetch) throw e; // surface fetch failures (e.g. auth)
    return null;
  }
  badge('behind-badge', s.hasUpstream ? s.behind : 0);
  badge('ahead-badge', s.hasUpstream ? s.ahead : 0);
  if (fetch && s.hasUpstream) {
    toast(s.behind ? `${s.behind} incoming commit(s) to pull` : 'Remote checked: already up to date',
      s.behind ? 'info' : 'success');
  }
  return s;
}

async function doPush() {
  const r = await withUi(api.post('/api/repo/push'), { loading: 'Pushing…', success: 'Push completed' });
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
    await refreshAll();
    showTab('merge');
    return;
  } else if (r.upToDate) {
    toast(r.note || 'Already up to date', 'success');
  } else if (r.rebased) {
    toast(r.fastForward ? 'Fast-forwarded to remote' : `Rebased: ${r.replayed} commit(s) replayed on top`, 'success');
  } else {
    toast('Pull completed', 'success');
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
  // The current mode gets a check (named for screen readers); the other one
  // keeps the same indent so the labels line up.
  const mark = (mode) => (pullMode === mode
    ? icon('check', { label: 'Current', className: 'ok' })
    : el('span', { class: 'icon', 'aria-hidden': 'true' }));
  openModal(
    el('h2', {}, 'Pull mode'),
    el('ul', { class: 'list-pick' },
      el('li', { onclick: pick('merge') },
        mark('merge'), ' Merge',
        el('span', { class: 'muted', style: 'margin-left:auto' }, 'creates a merge commit when branches diverge')),
      el('li', { onclick: pick('rebase') },
        mark('rebase'), ' Rebase',
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
        el('span', { title: fullDate(c.date) }, friendlyDate(c.date)),
      ),
    )));
}

/* Paged graph (docs/adr/0001): first page with the refresh, "Load more" for
   the next ones, tags fetched once per walk and applied on top. */
const GRAPH_PAGE = 200;
// `epoch` grows on every change to what the graph shows (new first page, a
// page appended). A response requested at an older epoch is stale: applying
// it could undo newer state — e.g. a watcher refresh asked for 1,000 rows
// while a reload of 1,200 was in flight, landed last, and dropped 200 rows.
const graph = { dir: null, walkId: null, view: null, loaded: 0, done: true, busy: false, epoch: 0 };

/**
 * First-page request for refreshAll. Same repo + known walk → the server
 * answers `unchanged` without walking (refs did not move). It asks for as
 * many rows as are loaded, so a real change does not throw away the user's
 * scroll depth.
 */
function graphRequestUrl() {
  const sameRepo = graph.dir === repo?.dir && graph.walkId;
  const limit = Math.max(GRAPH_PAGE, sameRepo ? graph.loaded : 0);
  return `/api/repo/graph?limit=${limit}${sameRepo ? `&known=${graph.walkId}` : ''}`;
}

/** Re-request the first pages from the CURRENT state (after dropping a stale response). */
async function reloadGraph() {
  const epoch = graph.epoch;
  const page = await api.get(graphRequestUrl()).catch(() => null);
  renderGraphTab(page, epoch);
}

/** Apply a first-page response requested at `epoch` (omit it for an unconditional render). */
function renderGraphTab(page, epoch) {
  if (!page || page.unchanged) return;
  if (epoch !== undefined && epoch !== graph.epoch) {
    // Stale. If it carried refs we are not showing, ask again from the current state.
    if (page.walkId !== graph.walkId) reloadGraph();
    return;
  }
  const wrap = $('graph-wrap');
  const sameRepo = graph.dir === repo.dir;
  const scrollTop = sameRepo ? wrap.scrollTop : 0;
  if (!sameRepo) graph.selectedOid = null; // a selection belongs to its repo
  Object.assign(graph, {
    dir: repo.dir, walkId: page.walkId, loaded: page.commits.length, done: page.done, busy: false,
  });
  graph.epoch++;
  graph.view?.destroy(); // stop the old view's scroll/resize listeners
  if (!page.commits.length) {
    graph.view = null;
    wrap.replaceChildren(el('p', { class: 'muted' }, 'No commits.'));
    return;
  }
  // The selected row survives rebuilds of the view (refs moved, a reload) — V-D.
  graph.view = new GraphView({ onSelect: (c) => { graph.selectedOid = c.oid; commitActions(c); }, scroller: wrap });
  wrap.replaceChildren(
    graph.view.reset(page.commits, { tips: page.tips, headOid: page.headOid, selectedOid: graph.selectedOid }),
    el('div', { class: 'graph-footer', id: 'graph-footer' }),
  );
  wrap.scrollTop = scrollTop;
  renderGraphFooter();
  loadGraphTags(page.walkId);
}

function renderGraphFooter() {
  const footer = $('graph-footer');
  if (!footer) return;
  setChildren(footer,
    graph.done
      ? el('span', { class: 'muted' }, `All ${graph.loaded} commits loaded`)
      : el('button', { class: 'btn btn-xs', id: 'btn-graph-more', disabled: graph.busy, onclick: loadMoreGraph },
        graph.busy ? 'Loading…' : `Load more commits (${graph.loaded} shown)`),
  );
}

async function loadMoreGraph() {
  if (graph.busy || graph.done || !graph.view) return;
  graph.busy = true;
  renderGraphFooter();
  const { walkId, loaded, epoch } = graph;
  try {
    const page = await api.get(`/api/repo/graph?walk=${walkId}&offset=${loaded}&limit=${GRAPH_PAGE}`);
    if (graph.epoch !== epoch) return; // a refresh replaced the graph meanwhile
    graph.view.append(page.commits);
    graph.loaded += page.commits.length;
    graph.done = page.done;
    graph.epoch++;
  } catch (err) {
    if (err.status === 409) {
      // Branches moved since the first page: reload what was shown plus one page.
      const page = await api.get(`/api/repo/graph?limit=${loaded + GRAPH_PAGE}`).catch(() => null);
      if (page) { renderGraphTab(page, epoch); return; }
    }
    toast(err.message, 'error');
  } finally {
    if (graph.walkId === walkId) { graph.busy = false; renderGraphFooter(); }
  }
}

async function loadGraphTags(walkId) {
  try {
    const { tags } = await api.get('/api/repo/graph/tags');
    if (graph.walkId === walkId && graph.view) graph.view.setTags(tags);
  } catch (err) {
    toast(`Could not load tags: ${err.message}`, 'error'); // the graph itself is fine
  }
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
    el('div', { class: 'modal-actions', style: 'flex-wrap:wrap' },
      el('button', {
        // Destructive but secondary: outlined, FIRST in the row (DOM order =
        // visual order = Tab order) and pushed away from the other actions and
        // Close (visual review, proposal C).
        class: 'btn btn-danger-ghost push-start', title: 'Destructive: moves the branch here and drops later commits',
        onclick: async () => {
          closeModal();
          if (await confirmModal('Hard reset to this commit',
            `The current branch will point to ${c.oid.slice(0, 7)} and the working directory will be restored (hard reset). Later commits are dropped from the branch. Are you sure?`)) {
            const r = await withUi(api.post('/api/repo/reset', { oid: c.oid }), { loading: 'Resetting…', success: 'Branch reset' });
            if (r) refreshAll();
          }
        },
      }, icon('rotate-ccw'), 'Hard reset…'),
      el('button', {
        class: 'btn', title: 'Create a new commit that undoes this one — history is preserved',
        onclick: async () => {
          closeModal();
          const r = await withUi(
            api.post('/api/repo/revert', { oid: c.oid, author: parseAuthor($('commit-author').value.trim()) }),
            { loading: 'Reverting…', success: 'Revert commit created' },
          );
          if (r) refreshAll();
        },
      }, icon('undo-2'), 'Revert (safe)'),
      el('button', {
        class: 'btn', title: 'Apply this commit on top of the current branch',
        onclick: async () => {
          closeModal();
          const r = await withUi(
            api.post('/api/repo/cherry-pick', { oid: c.oid, author: parseAuthor($('commit-author').value.trim()) }),
            { loading: 'Cherry-picking…', success: 'Commit cherry-picked' },
          );
          if (r) refreshAll();
        },
      }, icon('cherry'), 'Cherry-pick'),
      el('button', {
        class: 'btn',
        onclick: () => {
          const name = el('input', { type: 'text', placeholder: 'v1.0.0' });
          const create = async () => {
            if (!name.value.trim()) return;
            const r = await withUi(api.post('/api/repo/tag', { name: name.value.trim(), oid: c.oid }), { success: `Tag ${name.value} created` });
            if (r) { closeModal(); refreshAll(); }
          };
          name.addEventListener('keydown', (e) => { if (e.key === 'Enter') create(); });
          openModal(
            el('h2', {}, `Tag commit ${c.oid.slice(0, 7)}`),
            el('div', {}, el('label', {}, 'Tag name'), name),
            el('div', { class: 'modal-actions' },
              el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
              el('button', { class: 'btn btn-primary', onclick: create }, 'Create tag'),
            ),
          );
        },
      }, icon('tag'), 'Tag'),
      el('button', { class: 'btn', onclick: closeModal }, 'Close'),
    ),
  );
}

/* ============================================================= branches === */

function renderBranches(branches) {
  const li = (name, isCurrent, isRemote) => el('li', {},
    // full name in the title when it is cut with …
    el('span', { class: `bname ${isCurrent ? 'current' : ''}`, title: name },
      isCurrent ? icon('check', { label: 'Current branch' }) : icon(isRemote ? 'cloud' : 'git-branch'), ` ${name}`),
    !isCurrent && !isRemote && el('span', { class: 'actions row' },
      el('button', {
        class: 'btn btn-ghost btn-xs btn-icon', title: 'Switch to this branch', 'aria-label': `Switch to ${name}`,
        onclick: () => switchBranch(name),
      }, icon('arrow-right')),
      el('button', {
        class: 'btn btn-ghost btn-xs btn-icon', title: 'Delete', 'aria-label': `Delete branch ${name}`,
        onclick: async () => {
          if (await confirmModal('Delete branch', `Delete branch ${name}?`)) {
            const r = await withUi(api.post('/api/repo/branch/delete', { name }));
            if (r) refreshAll();
          }
        },
      }, icon('trash-2')),
    ),
    !isCurrent && isRemote && el('span', { class: 'actions row' },
      el('button', {
        class: 'btn btn-ghost btn-xs btn-icon', title: 'Checkout: create/switch to the matching local branch', 'aria-label': `Check out ${name}`,
        onclick: () => switchBranch(name),
      }, icon('arrow-right')),
      el('button', {
        class: 'btn btn-ghost btn-xs', title: 'Merge into current branch',
        onclick: () => mergeBranch(name),
      }, icon('git-merge'), 'merge'),
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
    ? `Created local branch ${r.branch} from ${r.tracking}`
    : `Branch: ${r.branch}`, 'success');
  refreshAll();
}

async function mergeBranch(theirRef) {
  const author = parseAuthor($('commit-author').value.trim());
  const r = await withUi(api.post('/api/repo/merge', { theirRef, author }), { loading: `Merging ${theirRef}…` });
  if (!r) return;
  await refreshAll();
  if (r.conflicts?.length) {
    toast(`Conflicts in ${r.conflicts.length} file(s)`, 'error', 6000);
    showTab('merge');
  } else {
    toast('Merge completed', 'success');
  }
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
          b === branches.current ? icon('check', { label: 'Current branch', className: 'ok' }) : icon('git-branch'), ` ${b}`)),
      branches.remote.map((b) =>
        el('li', { onclick: () => { closeModal(); switchBranch(b); } },
          icon('cloud'), ` ${b}`, el('span', { class: 'muted', style: 'margin-left:auto' }, 'checkout'))),
    ),
  );
});

/* ============================================================ conflicts === */

function renderMergeBanner(merge) {
  $('merge-banner').hidden = !merge;
  $('tab-btn-merge').hidden = !merge;
  updateCommitButton(); // "Complete merge" / its reason follow the merge state
  if (merge) {
    renderMergeView();
    // The open conflict file may no longer be part of this merge (another merge, another repo).
    if (conflictFile && !merge.files.includes(conflictFile)) closeConflict();
  } else {
    // Merge finished/aborted: nothing left to resolve (BACKLOG B-07).
    closeConflict();
    if (activeTab() === 'merge') showTab('graph');
  }
}

async function completeMergeAction() {
  const author = parseAuthor($('commit-author').value.trim());
  const r = await withUi(
    api.post('/api/repo/commit', { message: $('commit-msg').value.trim() || undefined, author }),
    { loading: 'Completing merge…', success: 'Merge completed' },
  );
  if (r) { $('commit-msg').value = ''; refreshAll(); }
}

async function abortMergeAction() {
  if (await confirmModal('Abort merge', 'Resolutions made so far will be discarded. Are you sure?')) {
    const r = await withUi(api.post('/api/repo/merge/abort'), { success: 'Merge aborted' });
    if (r) refreshAll();
  }
}

async function renderMergeView() {
  const s = await api.get('/api/repo/merge/state').catch(() => null);
  const view = $('merge-view');
  if (!s?.active) { view.replaceChildren(el('p', { class: 'muted' }, 'No merge in progress.')); return; }

  const resolvedCount = s.totalConflicts - s.pending;
  const pct = s.totalConflicts ? Math.round((resolvedCount / s.totalConflicts) * 100) : 100;

  const fileRow = (f) => el('li', {
    // Only conflicted rows do something: only they are clickable — and, through
    // el(), keyboard tab stops (B-24). Auto-merged rows stay plain text.
    onclick: f.conflicted ? () => openConflictEditor(f.filepath) : undefined,
    style: f.conflicted ? '' : 'cursor:default',
  },
    el('span', { class: `st st-${f.conflicted ? (f.resolved ? 'untracked' : 'conflicted') : 'modified'}` },
      f.conflicted ? '!' : { add: 'A', del: 'D', mod: 'M' }[f.type] || 'M'), // '!' as in the tree and Changes
    el('span', { class: 'fname', title: f.filepath }, f.filepath),
    el('span', { class: `mv-file-status ${f.conflicted ? (f.resolved ? 'ok' : 'pending') : 'ok'}` },
      f.conflicted && !f.resolved ? null : icon('check'),
      f.conflicted ? (f.resolved ? ' resolved' : 'needs resolution — click to open') : ' auto-merged'),
  );

  view.replaceChildren(
    el('div', { class: 'mv-head' },
      el('h1', {}, icon('git-merge', { className: 'icon-lg' }), ' Merging'),
      el('span', { class: 'mv-branch theirs' }, s.theirs),
      el('span', { class: 'mv-arrow' }, '→'),
      el('span', { class: 'mv-branch ours' }, s.ours),
    ),
    el('p', { class: 'muted' },
      `${s.incoming.length} incoming commit(s) · ${s.files.length} file(s) affected · ` +
      (s.pending ? `${s.pending} conflict(s) left to resolve` : 'all conflicts resolved — ready to complete')),
    el('div', { class: 'mv-progress-bar' }, el('div', { style: `width:${pct}%` })),
    el('span', { class: 'muted', style: 'font-size:11px' }, `${resolvedCount}/${s.totalConflicts} conflicts resolved`),

    el('div', { class: 'mv-section' },
      el('h3', {}, 'Files'),
      el('ul', { class: 'file-list' }, s.files.map(fileRow)),
    ),

    el('div', { class: 'mv-section' },
      el('h3', {}, `Incoming commits from ${s.theirs}`),
      el('ul', { class: 'commit-list' }, s.incoming.slice(0, 15).map((c) =>
        el('li', { onclick: () => commitActions(c) },
          el('div', { class: 'cmsg' }, c.message.split('\n')[0]),
          el('div', { class: 'cmeta' },
            el('span', { class: 'chash' }, c.oid.slice(0, 7)),
            el('span', {}, c.author),
            el('span', { title: fullDate(c.date) }, friendlyDate(c.date))),
        ))),
    ),

    // One primary action; when it cannot run yet it looks neutral and SAYS why.
    // Abort is destructive but secondary: outlined, at the far end, "…" because
    // a confirmation follows (visual review, proposal C).
    el('div', { class: 'mv-actions' },
      el('button', {
        class: 'btn btn-primary', disabled: s.pending > 0,
        'aria-describedby': s.pending ? 'mv-complete-reason' : null,
        onclick: completeMergeAction,
      }, 'Complete merge'),
      s.pending > 0 && el('span', { class: 'mv-reason', id: 'mv-complete-reason' },
        `Resolve ${s.pending} conflicted file${s.pending === 1 ? '' : 's'} first.`),
      el('button', { class: 'btn btn-danger-ghost push-end', onclick: abortMergeAction }, 'Abort merge…'),
    ),
  );
}

$('btn-merge-view').addEventListener('click', () => showTab('merge'));

let conflictFile = null;
let conflictSegments = [];
let conflictTextMode = false;

/** Hide the Conflict tab and forget the file it was editing. */
function closeConflict() {
  conflictFile = null;
  conflictSegments = [];
  conflictTextMode = false;
  $('c-text').classList.remove('btn-primary');
  $('conflict-path').textContent = '';
  $('conflict-visual').replaceChildren();
  $('conflict-editor').value = '';
  $('c-progress').textContent = '';
  document.querySelector('.tab[data-tab="conflict"]').hidden = true;
  if (activeTab() === 'conflict') showTab(repo?.merge ? 'merge' : 'graph');
}

function conflictProgress(unresolved, total) {
  $('c-progress').textContent = total
    ? (unresolved ? `${total - unresolved}/${total} resolved` : `all ${total} resolved`)
    : '';
  $('c-save').disabled = !conflictTextMode && unresolved > 0;
}

async function openConflictEditor(path) {
  const file = await withUi(api.get(`/api/repo/file?path=${encodeURIComponent(path)}`));
  if (!file) return;
  conflictFile = path;
  conflictTextMode = false;
  $('conflict-path').textContent = path;
  conflictSegments = parseConflicts(file.content || '');
  const hasConflicts = conflictSegments.some((s) => s.type === 'conflict');
  if (hasConflicts) {
    $('conflict-visual').hidden = false;
    $('conflict-editor').hidden = true;
    renderConflictUI($('conflict-visual'), conflictSegments,
      { ours: repo?.branch, theirs: repo?.merge?.theirRef }, conflictProgress);
  } else {
    // No markers (e.g. binary or already clean): fall back to plain text.
    conflictTextMode = true;
    $('conflict-visual').hidden = true;
    $('conflict-editor').hidden = false;
    $('conflict-editor').value = file.content || '';
    conflictProgress(0, 0);
  }
  showTab('conflict');
}

$('c-text').addEventListener('click', () => {
  conflictTextMode = !conflictTextMode;
  $('c-text').classList.toggle('btn-primary', conflictTextMode);
  if (conflictTextMode) {
    // Visual → text: keep picks already made, markers for the rest.
    $('conflict-editor').value = assembleConflicts(conflictSegments).text;
    $('conflict-visual').hidden = true;
    $('conflict-editor').hidden = false;
    $('c-save').disabled = false;
  } else {
    // Text → visual: re-parse whatever was typed.
    conflictSegments = parseConflicts($('conflict-editor').value);
    $('conflict-visual').hidden = false;
    $('conflict-editor').hidden = true;
    renderConflictUI($('conflict-visual'), conflictSegments,
      { ours: repo?.branch, theirs: repo?.merge?.theirRef }, conflictProgress);
  }
});

$('c-save').addEventListener('click', async () => {
  if (!conflictFile) return;
  let content;
  if (conflictTextMode) {
    content = $('conflict-editor').value;
    if (/^(<{7}|={7}|>{7})/m.test(content)) {
      return toast('There are still conflict markers left (<<<<<<< ======= >>>>>>>)', 'error');
    }
  } else {
    const { text, unresolved } = assembleConflicts(conflictSegments);
    if (unresolved > 0) return toast(`${unresolved} conflict(s) still unresolved`, 'error');
    content = text;
  }
  // One server call that refuses unless a merge is in progress and this file is in conflict.
  const staged = await withUi(api.post('/api/repo/conflict/resolve', { path: conflictFile, content }),
    { success: `Resolved: ${conflictFile}` });
  if (staged !== null) {
    await refreshAll();
    if (repo?.merge) showTab('merge'); // back to the overview to pick the next file
  }
});


/* ================================================================ stash === */

async function refreshStash() {
  try {
    const { list } = await api.get('/api/repo/stash');
    const items = Array.isArray(list) ? list : [];
    $('stash-list').replaceChildren(...items.map((s) =>
      el('li', {}, typeof s === 'string' ? s : JSON.stringify(s))));
  } catch {
    $('stash-list').replaceChildren(); // never the previous repo's stashes (BACKLOG B-21)
  }
}

const stashOp = (op) => async () => {
  const r = await withUi(api.post('/api/repo/stash', { op }), { success: `Stash: ${op}` });
  if (r) refreshAll();
};
$('btn-stash-push').addEventListener('click', stashOp('push'));
$('btn-stash-apply').addEventListener('click', stashOp('apply'));
$('btn-stash-pop').addEventListener('click', stashOp('pop'));

/* ========================================================== file editor === */

let currentFile = null;
let fileDirty = false;
// Disk content as of the last open/save: the baseline to tell OUR edits apart
// from changes made outside git-nd (another editor, a script, a git command).
let loadedContent = null;
let fileStale = false; // disk changed under unsaved edits

function renderFileStatus() {
  setChildren($('file-dirty'),
    fileDirty && '● unsaved',
    fileDirty && fileStale && ' · ',
    fileStale && icon('triangle-alert', { className: 'warn' }),
    fileStale && ' changed on disk');
}

function setDirty(dirty) {
  fileDirty = dirty;
  renderFileStatus();
}

const fetchFile = (path) => api.get(`/api/repo/file?path=${encodeURIComponent(path)}`);

/**
 * Called on watcher events. Without this the editor keeps showing what was on
 * disk when it was opened, and a later Save silently overwrites external edits.
 * - disk unchanged → nothing
 * - clean editor   → reload in place
 * - unsaved edits  → keep them, flag the file; saveFile() asks before overwriting
 */
async function checkFileOnDisk() {
  if (!currentFile) return;
  const path = currentFile;
  const file = await fetchFile(path).catch(() => null); // deleted/unreadable: nothing to sync
  if (!file || file.binary || path !== currentFile) return; // switched file meanwhile
  const editor = $('file-editor');
  if (file.content === loadedContent) return;
  if (file.content === editor.value) { // e.g. our own save landing: in sync
    loadedContent = file.content;
    fileStale = false;
    setDirty(false);
    return;
  }
  if (!fileDirty) {
    loadedContent = file.content;
    const { selectionStart, selectionEnd, scrollTop } = editor;
    editor.value = file.content;
    editor.setSelectionRange(selectionStart, selectionEnd);
    editor.scrollTop = scrollTop;
    toast(`Reloaded "${path}": it changed on disk`);
    return;
  }
  // loadedContent stays the OLD baseline on purpose: saveFile() compares
  // against it to detect the external change and ask before overwriting.
  fileStale = true;
  renderFileStatus();
}

async function openFile(path) {
  // Reopening the same file with unsaved edits: don't reload (it would discard
  // them). Just make sure the File tab is visible.
  if (fileDirty && currentFile === path) { showTab('file'); return; }
  // Switching to a different file with unsaved edits would silently discard
  // them: ask first.
  if (fileDirty && currentFile && currentFile !== path) {
    const ok = await confirmModal('Discard changes', `"${currentFile}" has unsaved changes. Discard and open "${path}"?`);
    if (!ok) return;
  }
  const file = await withUi(fetchFile(path));
  if (!file) return;
  const editor = $('file-editor');
  currentFile = file.binary ? null : path;
  loadedContent = file.binary ? null : file.content;
  fileStale = false;
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
  const path = currentFile;
  // Checked here too, not only via the watcher: it skips dirs like dist/ and
  // build/, and its event may not have arrived yet.
  const disk = await fetchFile(path).catch(() => null);
  if (disk && !disk.binary && disk.content !== loadedContent && disk.content !== $('file-editor').value) {
    const ok = await confirmModal('File changed on disk',
      `"${path}" was modified outside git-nd after you opened it. Overwrite those changes with yours?`);
    if (!ok || path !== currentFile) return;
  }
  const content = $('file-editor').value;
  const r = await withUi(api.post('/api/repo/file', { path, content }), { success: `Saved: ${path}` });
  if (r === null) return;
  if (path === currentFile) {
    loadedContent = content;
    fileStale = false;
    setDirty($('file-editor').value !== content); // typed while saving → still dirty
  }
  refreshAll();
}

$('file-editor').addEventListener('input', () => setDirty(true));
$('btn-save-file').addEventListener('click', saveFile);

/** Close the File tab: clear state and hide the tab (it is revealed again on open). */
function closeFile() {
  currentFile = null;
  loadedContent = null;
  fileStale = false;
  setDirty(false);
  $('file-editor').value = '';
  $('file-path').textContent = '';
  document.querySelector('.tab[data-tab="file"]').hidden = true;
  showTab('graph');
}
$('btn-close-file').addEventListener('click', async () => {
  if (fileDirty && !(await confirmModal('Discard changes', `"${currentFile}" has unsaved changes. Close anyway?`))) return;
  closeFile();
});

/** Working-copy diff split into hunks with stage/unstage/discard per hunk. */
async function showWorkdirDiff(path, staged) {
  const target = staged ? 'staged' : 'unstaged';
  const data = await withUi(api.get(`/api/repo/hunks?file=${encodeURIComponent(path)}&target=${target}`));
  if (!data) return;
  $('diff-path').textContent = `${path} — ${staged ? 'staged changes (index vs HEAD)' : 'unstaged changes (working copy vs index)'}`;

  const blocks = data.hunks.map((hk) => {
    const actions = staged
      ? [el('button', {
          class: 'btn btn-xs', onclick: () => hunkOp('unstage', path, hk.index, staged),
        }, '⊖ Unstage hunk')]
      : [
          el('button', {
            class: 'btn btn-xs btn-primary', onclick: () => hunkOp('stage', path, hk.index, staged),
          }, '⊕ Stage hunk'),
          el('button', {
            class: 'btn btn-xs', title: 'Revert this change in your working file',
            onclick: async () => {
              if (await confirmModal('Discard hunk', 'This change will be permanently removed from your working file. Are you sure?')) {
                hunkOp('discard', path, hk.index, staged);
              }
            },
          }, '↺ Discard'),
        ];
    return el('div', { class: 'hunk-block' },
      el('div', { class: 'hunk-head' },
        el('code', {}, hk.header),
        el('span', { class: 'spacer' }),
        ...actions),
      renderDiff(hk.rows),
    );
  });

  setChildren($('diff-view'),
    blocks.length
      ? el('div', { class: 'hunk-wrap' }, blocks)
      : el('p', { class: 'muted pad' }, data.symlink
        ? 'Symbolic link: it has no hunks. Stage or discard it as a whole from the Changes list.'
        : staged ? 'Nothing staged for this file.' : 'No unstaged changes for this file.'),
  );
  showTab('diff');
}

async function hunkOp(op, path, index, staged) {
  const labels = { stage: 'Hunk staged ⊕', unstage: 'Hunk unstaged ⊖', discard: 'Hunk discarded ↺' };
  const r = await withUi(api.post(`/api/repo/hunks/${op}`, { path, hunks: [index] }), { success: labels[op] });
  if (r === null) return;
  await refreshAll();
  // Re-render remaining hunks — unless the user closed the Diff tab meanwhile.
  if (!document.querySelector('.tab[data-tab="diff"]').hidden) showWorkdirDiff(path, staged);
}

/** Close the Diff tab (read-only, nothing to lose); revealed again by the next diff. */
/** Close the Diff tab: drop its content (and with it every hunk button bound to a path). */
function closeDiff() {
  $('diff-path').textContent = '';
  $('diff-view').replaceChildren();
  document.querySelector('.tab[data-tab="diff"]').hidden = true;
  if (activeTab() === 'diff') showTab('graph');
}
$('btn-close-diff').addEventListener('click', closeDiff);

/**
 * Leaving a repo: every view bound to a path of the OLD repo must go, or its
 * buttons act on the new one — a stale "Discard hunk" wiped changes in the
 * repo opened next (BACKLOG B-04).
 */
function closeRepoViews() {
  closeFile();
  closeDiff();
  closeConflict();
}

async function showDiff(path, oid, base) {
  const q = (oid ? `&oid=${oid}` : '') + (base ? `&base=${base}` : '');
  const diff = await withUi(api.get(`/api/repo/diff?file=${encodeURIComponent(path)}${q}`));
  if (!diff) return;
  $('diff-path').textContent = oid
    ? `${path} @ ${base ? `${base.slice(0, 7)}..` : ''}${oid.slice(0, 7)}`
    : path;
  $('diff-view').replaceChildren(renderDiff(diff.rows));
  showTab('diff');
}

/* =========================================================== open/clone === */

/**
 * Switching repository with a file open: unsaved edits would be orphaned, and
 * currentFile (a path relative to the OLD repo) would make Ctrl+S write into
 * the new one. Ask before switching; returns false to abort.
 */
async function confirmLeaveFile() {
  if (!fileDirty) return true;
  return confirmModal('Discard changes', `"${currentFile}" has unsaved changes. Discard and switch repository?`);
}

// True while THIS tab is opening/cloning a repo: the server's `repo-opened`
// broadcast arrives before the response, and must not read as "switched
// from another window".
let switchingRepo = false;

async function openRepo(dir) {
  if (!(await confirmLeaveFile())) return;
  switchingRepo = true;
  let info;
  try {
    info = await withUi(api.post('/api/repo/open', { dir }), { loading: 'Opening repository…' });
    if (!info) return;
    closeRepoViews();
    repo = info; // only now may a refresh compare against the new repo
  } finally {
    switchingRepo = false;
  }
  addRecent(info.dir);
  closeModal();
  toast(`Repository opened: ${info.name}`, 'success');
  loadAuthor();
  refreshAll({ loading: true });
  switchView('repo');
  showTab('graph');
}

async function cloneModal(prefillUrl = '') {
  // Asked up front: confirmModal shares the single modal and would wipe the form.
  if (!(await confirmLeaveFile())) return;
  const url = el('input', { type: 'text', placeholder: 'https://github.com/user/repo.git', value: prefillUrl });
  const dest = el('input', { type: 'text', placeholder: '(optional) folder — relative paths go under ~/git-nd-repos' });
  // Live preview of the exact destination, resolved by the server with the
  // same rule it uses to clone — so "where did it go?" is answered up front.
  const where = el('p', { class: 'muted', style: 'margin:4px 0 0; word-break:break-all' });
  const cloneBtn = el('button', { class: 'btn btn-primary', onclick: () => go() }, 'Clone');
  let previewSeq = 0;
  let previewTimer = null;
  const updatePreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const seq = ++previewSeq;
      if (!url.value.trim() && !dest.value.trim()) { where.textContent = ''; return; }
      const q = `url=${encodeURIComponent(url.value.trim())}&dir=${encodeURIComponent(dest.value.trim())}`;
      const t = await api.get(`/api/repo/clone-target?${q}`).catch(() => null);
      if (seq !== previewSeq || !t) return; // a newer keystroke already asked
      if (t.notEmpty) where.replaceChildren(icon('triangle-alert', { className: 'bad' }), ` ${t.dir} already exists and is not empty — choose another folder`);
      else where.textContent = `Will be cloned into: ${t.dir}`;
      cloneBtn.disabled = t.notEmpty;
    }, 200);
  };
  url.addEventListener('input', updatePreview);
  dest.addEventListener('input', updatePreview);
  updatePreview();

  const go = async () => {
    if (!url.value.trim()) return;
    switchingRepo = true; // see openRepo
    const info = await withUi(
      api.post('/api/repo/clone', { url: url.value.trim(), dir: dest.value.trim() || undefined }),
      { loading: 'Cloning… this may take a while' },
    );
    if (!info) switchingRepo = false;
    if (info) {
      toast(`Repository cloned into ${info.dir}`, 'success', 6000);
      closeRepoViews();
      repo = info;
      switchingRepo = false;
      addRecent(info.dir);
      closeModal();
      loadAuthor();
      refreshAll();
      switchView('repo');
      showTab('graph');
    }
  };
  openModal(
    el('h2', {}, 'Clone repository'),
    el('div', {}, el('label', {}, 'URL'), url),
    el('div', {}, el('label', {}, 'Target'), dest, where),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      cloneBtn,
    ),
  );
}

$('btn-clone').addEventListener('click', () => cloneModal());
$('repo-name').addEventListener('click', () => switchView('explorer'));
$('btn-refresh-tree').addEventListener('click', refreshAll);

/* Files sidebar collapse (visual review 2, F1). Persisted like the theme;
   storage can throw (private mode, blocked site data) — then it just doesn't persist. */
function setFilesCollapsed(collapsed, { persist = true } = {}) {
  $('layout').classList.toggle('files-collapsed', collapsed);
  $('tree').hidden = collapsed;
  $('btn-refresh-tree').hidden = collapsed;
  const toggle = $('btn-files-toggle');
  const label = collapsed ? 'Show files' : 'Hide files';
  toggle.setAttribute('aria-expanded', String(!collapsed));
  toggle.setAttribute('aria-label', label);
  toggle.title = label;
  if (persist) try { localStorage.setItem('gitnd-files-collapsed', collapsed ? '1' : '0'); } catch { /* not persisted */ }
}
const filesCollapsed = () => $('layout').classList.contains('files-collapsed');
$('btn-files-toggle').addEventListener('click', () => setFilesCollapsed(!filesCollapsed()));
$('files-rail-label').addEventListener('click', () => setFilesCollapsed(false));
try { if (localStorage.getItem('gitnd-files-collapsed') === '1') setFilesCollapsed(true, { persist: false }); } catch { /* starts expanded */ }

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

$('btn-list-prs').addEventListener('click', async () => {
  if (!repo) return toast('Open a repository first', 'error');
  const provider = providerFromOrigin();
  const slug = originRepoSlug();
  const data = await withUi(
    api.get(`/api/providers/prs?provider=${provider}&repo=${encodeURIComponent(slug)}`),
    { loading: 'Loading pull requests…' },
  );
  if (!data) return;
  openModal(
    el('h2', {}, `Open PRs / MRs — ${slug}`),
    el('ul', { class: 'list-pick' },
      data.prs.length
        ? data.prs.map((p) => el('li', { onclick: () => window.open(p.url, '_blank') },
            el('span', {}, `#${p.number}`),
            el('div', { style: 'flex:1;min-width:0' },
              el('div', {}, icon(p.draft ? 'git-pull-request-draft' : 'git-pull-request', p.draft ? { label: 'Draft' } : {}), ` ${p.title}`),
              el('div', { class: 'muted', style: 'font-size:11px' },
                `${p.sourceBranch} → ${p.targetBranch} · ${p.author} · ${new Date(p.createdAt).toLocaleDateString()}`)),
          ))
        : el('li', { class: 'muted' }, 'No open pull requests.')),
    el('div', { class: 'modal-actions' }, el('button', { class: 'btn', onclick: closeModal }, 'Close')),
  );
});

$('btn-create-pr').addEventListener('click', async () => {
  if (!repo) return toast('Open a repository first', 'error');
  const branches = await api.get('/api/repo/branches').catch(() => null);
  if (!branches) return;

  // Target candidates: every branch name known locally or on origin.
  const remoteNames = branches.remote.map((b) => b.replace(/^origin\//, ''));
  const targets = [...new Set([...remoteNames, ...branches.local])];
  const defaultTarget = ['main', 'master', 'develop'].find((b) => targets.includes(b)) || targets[0];

  const option = (v, selected) => el('option', { value: v, selected }, v);
  const slug = el('input', { type: 'text', value: originRepoSlug(), placeholder: 'owner/repo' });
  const title = el('input', { type: 'text', placeholder: 'PR title' });
  const body = el('textarea', { placeholder: 'Description (optional)' });
  const source = el('select', {}, branches.local.map((b) => option(b, b === branches.current)));
  const target = el('select', {}, targets.map((b) => option(b, b === defaultTarget)));
  const preview = el('div', {});

  const typeLabel = { add: 'A', del: 'D', mod: 'M' };
  const typeClass = { add: 'untracked', del: 'deleted', mod: 'modified' };

  // Accordion: the file's line diff opens inside the modal, keeping your draft.
  async function toggleInlineDiff(li, f, cmp) {
    const next = li.nextElementSibling;
    if (next?.classList.contains('inline-diff')) { next.remove(); return; }
    const d = await api.get(
      `/api/repo/diff?file=${encodeURIComponent(f.filepath)}&oid=${cmp.headOid}&base=${cmp.baseOid}`,
    ).catch((e) => { toast(e.message, 'error'); return null; });
    if (!d) return;
    li.after(el('li', { class: 'inline-diff' }, el('div', { class: 'inline-diff-box' }, renderDiff(d.rows))));
  }

  async function updatePreview() {
    if (source.value === target.value) {
      setChildren(preview, el('p', { class: 'muted' }, 'Source and target are the same branch.'));
      return;
    }
    // The PR is against the remote: compare with origin/<target> when it exists.
    const baseRef = branches.remote.includes(`origin/${target.value}`) ? `origin/${target.value}` : target.value;
    const cmp = await api.get(`/api/repo/compare?base=${encodeURIComponent(baseRef)}&head=${encodeURIComponent(source.value)}`)
      .catch(() => null);
    if (!cmp) { setChildren(preview, el('p', { class: 'muted' }, 'Could not compare branches.')); return; }

    const notPushed = !branches.remote.includes(`origin/${source.value}`);
    setChildren(preview,
      el('div', { class: 'subsection-title' },
        `${cmp.commits.length} commit(s) · ${cmp.files.length} file(s) — ${baseRef} ← ${source.value}`),
      cmp.commits.length === 0
        ? el('p', { class: 'muted', style: 'padding:0 12px' }, 'No commits to merge: nothing to create a PR from.')
        : el('ul', { class: 'file-list', style: 'max-height:38vh;overflow:auto' },
            cmp.files.map((f) => {
              const li = el('li', { title: 'Click to toggle the line diff' },
                el('span', { class: `st st-${typeClass[f.type]}` }, typeLabel[f.type]),
                el('span', { class: 'fname' }, f.filepath),
              );
              li.addEventListener('click', () => toggleInlineDiff(li, f, cmp));
              makeActivatable(li); // the listener above is not set through el(): keyboard too (B-24)
              return li;
            })),
      notPushed && el('p', { class: 'muted', style: 'padding:0 12px' },
        icon('triangle-alert', { className: 'warn' }), ` ${source.value} is not on origin yet — push it before creating the PR, or the provider will reject it.`),
    );
  }
  source.addEventListener('change', updatePreview);
  target.addEventListener('change', updatePreview);

  openModal(
    el('h2', {}, 'Create Pull Request / Merge Request'),
    el('div', {}, el('label', {}, 'Repository'), slug),
    el('div', { class: 'row' },
      el('div', { style: 'flex:1' }, el('label', {}, 'From (source)'), source),
      el('div', { style: 'flex:1' }, el('label', {}, 'Into (target)'), target),
    ),
    preview,
    el('div', {}, el('label', {}, 'Title'), title),
    el('div', {}, el('label', {}, 'Description'), body),
    el('div', { class: 'modal-actions' },
      el('button', { class: 'btn', onclick: closeModal }, 'Cancel'),
      el('button', {
        class: 'btn btn-primary',
        onclick: async () => {
          if (!title.value.trim()) { title.focus(); return toast('Write a PR title', 'error'); }
          const r = await withUi(api.post('/api/providers/pr', {
            provider: providerFromOrigin(), repo: slug.value.trim(),
            title: title.value.trim(), body: body.value,
            sourceBranch: source.value, targetBranch: target.value,
          }), { loading: 'Creating PR…' });
          if (r) { closeModal(); toast(`PR #${r.number} created`, 'success', 6000); window.open(r.url, '_blank'); }
        },
      }, 'Create'),
    ),
  );
  document.getElementById('modal').classList.add('wide'); // room for inline diffs
  updatePreview();
});

$('btn-issues').addEventListener('click', async () => {
  if (!repo) return toast('Open a repository first', 'error');
  const provider = providerFromOrigin();
  const slug = originRepoSlug();
  const data = await withUi(api.get(`/api/providers/issues?provider=${provider}&repo=${encodeURIComponent(slug)}`), { loading: 'Loading issues…' });
  if (!data) return;
  const title = el('input', { type: 'text', placeholder: 'New issue title' });
  openModal(
    el('h2', {}, `Issues for ${slug}`),
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
          if (r) { closeModal(); toast(`Issue #${r.number} created`, 'success'); }
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
  const key = e.key.toLowerCase();
  if (key !== 's' && key !== 'p') return;
  e.preventDefault(); // never the browser's own Save / Print dialogs
  // A modal owns the keyboard: no commit, push or quick-open happening behind
  // it (BACKLOG B-10 — Ctrl+S used to commit with the Pull-mode dialog open).
  if (!$('modal-backdrop').hidden) return;
  if (key === 's' && !e.shiftKey) {
    // Context-aware Ctrl+S: save what the active editor holds, else commit.
    const tab = activeTab();
    if (tab === 'file') {
      if (currentFile) saveFile(); // binary file: currentFile is null → nothing to save, and no commit
    } else if (tab === 'conflict') {
      if (conflictFile && !$('c-save').disabled) $('c-save').click();
    } else {
      doCommit();
    }
  } else if (key === 'p' && e.shiftKey) doPush();
  else if (key === 'p') quickOpen();
});

$('btn-theme').addEventListener('click', () => {
  const html = document.documentElement;
  const next = html.dataset.theme === 'dark' ? 'light' : 'dark';
  html.dataset.theme = next;
  localStorage.setItem('gitnd-theme', next);
  applyThemeButton(next);
});
/* The button shows the theme you would switch TO, and says so — set at load
   too (it used to show 🌙 until the first click, whatever the saved theme). */
function applyThemeButton(theme) {
  const other = theme === 'dark' ? 'light' : 'dark';
  $('btn-theme').replaceChildren(icon(other === 'light' ? 'sun' : 'moon'));
  $('btn-theme').setAttribute('aria-label', `Switch to ${other} theme`);
  $('btn-theme').title = `Switch to ${other} theme`;
}
document.documentElement.dataset.theme = localStorage.getItem('gitnd-theme') || 'dark';
applyThemeButton(document.documentElement.dataset.theme);

/* =============================================================== events === */

onEvent('file-changed', () => refreshAll());
// Another client opened a repo: refresh now, so this tab never keeps acting on the old one.
onEvent('repo-opened', () => { if (repo) refreshAll(); });

// External changes (editor saves, terminal git commands) detected by the
// server-side watcher. Debounced again here: our own operations also trip it.
let fsRefreshTimer = null;
onEvent('fs-changed', () => {
  clearTimeout(fsRefreshTimer);
  fsRefreshTimer = setTimeout(() => { if (repo) { refreshAll(); checkFileOnDisk(); } }, 250);
});

/* ================================================================= boot === */

(async function boot() {
  initTreeDnD();
  applyPullModeUi();
  authStatus = await api.get('/api/auth/status').catch(() => null);
  updateAuthButton();
  try {
    repo = await api.get('/api/repo/info');
    loadAuthor();
    refreshAll({ loading: true });
    switchView('repo');
  } catch {
    switchView('explorer'); // nothing open → start where you pick a repo
  }
})();

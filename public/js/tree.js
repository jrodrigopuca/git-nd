import { api, withUi } from './api.js';
import { el, icon, fileIcon, toast, makeActivatable } from './ui.js';

const container = () => document.getElementById('tree');
const expanded = new Set();
let statusMap = new Map();
let onOpenFile = () => {};

export function setOpenFileHandler(fn) { onOpenFile = fn; }

export function setStatusMap(files) {
  statusMap = new Map();
  for (const f of files) {
    const st = f.conflicted ? 'conflicted' : (f.workStatus || f.stageStatus);
    statusMap.set(f.filepath, st);
    // Propagate a dot to parent folders
    const parts = f.filepath.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!statusMap.has(dir)) statusMap.set(dir, 'dirty');
    }
  }
}

const ST_LABEL = { modified: 'M', untracked: 'U', deleted: 'D', added: 'A', conflicted: '!', dirty: '·' };

async function renderLevel(path) {
  const entries = await api.get(`/api/repo/tree?path=${encodeURIComponent(path)}`);
  return el('div', { class: 'tree-children' }, entries.map(renderNode));
}

function renderNode(entry) {
  const node = el('div', { class: 'tree-node', dataset: { path: entry.path, type: entry.type } });
  const st = statusMap.get(entry.path);
  const row = el('div', { class: 'tree-row' },
    // A chevron that CSS rotates from the row's aria-expanded: one source of truth.
    el('span', { class: 'twisty' }, entry.type === 'dir' ? icon('chevron-right', { className: 'icon-sm' }) : null),
    el('span', { class: 'ficon' }, fileIcon(entry.name, entry.type, expanded.has(entry.path))),
    el('span', { class: 'nm' }, entry.name),
    st ? el('span', { class: `st st-${st}` }, ST_LABEL[st] || '') : null,
  );

  // Every expand/collapse bumps `seq`; a children load that comes back after
  // a newer click is dropped. Before, a quick double click collapsed while the
  // expand was still loading, then the children were appended anyway (closed
  // chevron with children shown), and the next click appended a second set (BACKLOG B-15).
  let seq = 0;
  const setFolderIcon = (open) => row.querySelector('.ficon').replaceChildren(fileIcon(entry.name, entry.type, open));
  // Keyboard: rows are focusable and open/toggle with Enter or Space (BACKLOG
  // B-24); folders announce whether they are expanded.
  makeActivatable(row);
  row.setAttribute('aria-label', `${entry.type === 'dir' ? 'Folder' : 'File'} ${entry.path}`);
  if (entry.type === 'dir') row.setAttribute('aria-expanded', String(expanded.has(entry.path)));
  const collapse = () => {
    seq++;
    expanded.delete(entry.path);
    node.querySelector('.tree-children')?.remove();
    setFolderIcon(false);
    row.setAttribute('aria-expanded', 'false');
  };
  const expand = async () => {
    const mine = ++seq;
    expanded.add(entry.path);
    setFolderIcon(true);
    row.setAttribute('aria-expanded', 'true');
    let children;
    try {
      children = await renderLevel(entry.path);
    } catch {
      if (mine === seq) collapse(); // e.g. the folder was deleted meanwhile
      return;
    }
    if (mine !== seq) return; // a newer click won
    node.querySelector('.tree-children')?.remove();
    node.append(children);
  };

  row.addEventListener('click', () => {
    container().querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
    if (entry.type !== 'dir') onOpenFile(entry.path);
    else if (expanded.has(entry.path)) collapse();
    else expand();
  });

  node.append(row);
  if (entry.type === 'dir' && expanded.has(entry.path)) expand(); // re-expand after a refresh
  return node;
}

let treeSeq = 0; // a slower, older tree response must not replace a newer one (BACKLOG B-18)

export async function refreshTree() {
  const mine = ++treeSeq;
  try {
    const entries = await api.get('/api/repo/tree?path=.');
    if (mine !== treeSeq) return;
    container().replaceChildren(...entries.map(renderNode));
  } catch {
    /* no repo open yet */
  }
}

/* ---- drag & drop: drop OS files into the repo ---- */
export function initTreeDnD() {
  // The whole sidebar is the drop zone, so the collapsed rail (no tree
  // visible) still accepts a file: it lands at the repo root.
  const zone = document.getElementById('sidebar');
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('dragover'); });
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');
    const targetNode = e.target.closest('.tree-node');
    let baseDir = '';
    if (targetNode) {
      const path = targetNode.dataset.path;
      // The node says what it is; the twisty's look (text or SVG) is not data.
      baseDir = targetNode.dataset.type === 'dir' ? path : path.split('/').slice(0, -1).join('/');
    }
    for (const file of e.dataTransfer.files) {
      const content = await file.text();
      const dest = baseDir ? `${baseDir}/${file.name}` : file.name;
      const ok = await withUi(api.post('/api/repo/file', { path: dest, content }));
      if (ok) toast(`File added: ${dest}`, 'success');
    }
    refreshTree();
  });
}

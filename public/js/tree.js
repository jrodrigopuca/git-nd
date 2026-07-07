import { api, withUi } from './api.js';
import { el, fileIcon, toast } from './ui.js';

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
  const node = el('div', { class: 'tree-node', dataset: { path: entry.path } });
  const st = statusMap.get(entry.path);
  const row = el('div', { class: 'tree-row' },
    el('span', { class: 'twisty' }, entry.type === 'dir' ? (expanded.has(entry.path) ? '▼' : '▶') : ''),
    el('span', {}, fileIcon(entry.name, entry.type)),
    el('span', { class: 'nm' }, entry.name),
    st ? el('span', { class: `st st-${st}` }, ST_LABEL[st] || '') : null,
  );

  row.addEventListener('click', async () => {
    container().querySelectorAll('.tree-row.selected').forEach((r) => r.classList.remove('selected'));
    row.classList.add('selected');
    if (entry.type === 'dir') {
      if (expanded.has(entry.path)) {
        expanded.delete(entry.path);
        node.querySelector('.tree-children')?.remove();
        row.querySelector('.twisty').textContent = '▶';
      } else {
        expanded.add(entry.path);
        row.querySelector('.twisty').textContent = '▼';
        node.append(await renderLevel(entry.path));
      }
    } else {
      onOpenFile(entry.path);
    }
  });

  node.append(row);
  if (entry.type === 'dir' && expanded.has(entry.path)) {
    renderLevel(entry.path).then((children) => node.append(children));
  }
  return node;
}

export async function refreshTree() {
  try {
    const entries = await api.get('/api/repo/tree?path=.');
    container().replaceChildren(...entries.map(renderNode));
  } catch {
    /* no repo open yet */
  }
}

/* ---- drag & drop: drop OS files into the repo ---- */
export function initTreeDnD() {
  const tree = container();
  tree.addEventListener('dragover', (e) => { e.preventDefault(); tree.classList.add('dragover'); });
  tree.addEventListener('dragleave', () => tree.classList.remove('dragover'));
  tree.addEventListener('drop', async (e) => {
    e.preventDefault();
    tree.classList.remove('dragover');
    const targetNode = e.target.closest('.tree-node');
    let baseDir = '';
    if (targetNode) {
      const path = targetNode.dataset.path;
      const twisty = targetNode.querySelector('.twisty')?.textContent;
      baseDir = twisty ? path : path.split('/').slice(0, -1).join('/');
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

/** DOM helper: el('div', {class: 'x', onclick: fn}, child1, 'text', …) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue; // allow `cond && el(…)` patterns
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

export function toast(message, kind = 'info', ms = 3500) {
  const box = document.getElementById('toasts');
  const node = el('div', { class: `toast ${kind}` }, message);
  box.append(node);
  setTimeout(() => node.remove(), ms);
}

/* ---- modal ---- */
const backdrop = () => document.getElementById('modal-backdrop');
const modalBox = () => document.getElementById('modal');

export function openModal(...content) {
  const modal = modalBox();
  // replaceChildren coerces null/false to literal "null"/"false" text nodes.
  modal.replaceChildren(...content.filter((c) => c != null && c !== false));
  backdrop().hidden = false;
  const first = modal.querySelector('input, textarea, select');
  if (first) setTimeout(() => first.focus(), 30);
}

export function closeModal() {
  backdrop().hidden = true;
  const modal = modalBox();
  modal.classList.remove('wide');
  modal.replaceChildren();
}

/** Safe replaceChildren: drops null/false instead of rendering them as text. */
export function setChildren(node, ...children) {
  node.replaceChildren(...children.flat().filter((c) => c != null && c !== false));
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeModal();
});
document.addEventListener('click', (e) => {
  if (e.target === backdrop()) closeModal();
});

/** Simple confirm modal returning a promise<boolean>. */
export function confirmModal(title, text) {
  return new Promise((resolve) => {
    openModal(
      el('h2', {}, title),
      el('p', {}, text),
      el('div', { class: 'modal-actions' },
        el('button', { class: 'btn', onclick: () => { closeModal(); resolve(false); } }, 'Cancel'),
        el('button', { class: 'btn btn-danger', onclick: () => { closeModal(); resolve(true); } }, 'Confirm'),
      ),
    );
  });
}

/* ---- file icons by extension ---- */
const ICONS = {
  js: '🟨', mjs: '🟨', cjs: '🟨', ts: '🟦', tsx: '⚛️', jsx: '⚛️',
  json: '🧾', md: '📝', html: '🌐', css: '🎨', scss: '🎨',
  py: '🐍', rb: '💎', go: '🐹', rs: '🦀', java: '☕', php: '🐘',
  sh: '💲', yml: '⚙️', yaml: '⚙️', toml: '⚙️', lock: '🔒',
  png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️', ico: '🖼️',
  pdf: '📕', zip: '📦', gz: '📦', env: '🔑', gitignore: '🚫',
};

export function fileIcon(name, type) {
  if (type === 'dir') return '📁';
  const ext = name.split('.').pop().toLowerCase();
  return ICONS[ext] || '📄';
}

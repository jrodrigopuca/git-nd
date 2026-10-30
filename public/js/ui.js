/**
 * Short, human date for lists and the graph (visual review V-D): "just now",
 * "12 min ago", "3 h ago", "2 d ago", then "Oct 29" (this year) or
 * "Oct 29, 2024". Pair it with fullDate() in a title for the exact moment.
 * Relative values are computed at render time; a refresh renders them again.
 */
export function friendlyDate(ms, now = Date.now()) {
  const s = Math.round((now - ms) / 1000);
  if (s < 60 && s > -60) return 'just now';
  if (s > 0 && s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s > 0 && s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s > 0 && s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  const d = new Date(ms);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(undefined, sameYear ? { month: 'short', day: 'numeric' } : { year: 'numeric', month: 'short', day: 'numeric' });
}
export const fullDate = (ms) => new Date(ms).toLocaleString();

const NATIVELY_INTERACTIVE = new Set(['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION', 'LABEL']);

/**
 * Make a clickable non-control (li, div, span, svg g…) usable with the
 * keyboard: focusable, announced as a button, activated by Enter or Space
 * (BACKLOG B-24). The key only counts when focus is ON this element, so a
 * button nested inside does its own thing without also firing the row.
 */
export function makeActivatable(node) {
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');
  if (!node.hasAttribute('role')) node.setAttribute('role', 'button');
  node.addEventListener('keydown', (e) => {
    if (e.target !== node || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault(); // Space would scroll the page
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

/** DOM helper: el('div', {class: 'x', onclick: fn}, child1, 'text', …) */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (value !== false && value != null) node.setAttribute(key, value === true ? '' : value);
  }
  // Anything clickable must be keyboard-operable too, not only real controls.
  if (attrs.onclick && !NATIVELY_INTERACTIVE.has(node.tagName)) makeActivatable(node);
  for (const child of children.flat()) {
    if (child == null || child === false) continue; // allow `cond && el(…)` patterns
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

/**
 * An icon from the local sprite (public/icons/sprite.svg, Lucide + Simple
 * Icons). Decorative by default (aria-hidden): the control around it carries
 * the name. Pass { label } only when the icon itself is the information.
 * Color is the text color (currentColor) — style it with tokens, never fills.
 */
const SVG_NS = 'http://www.w3.org/2000/svg';
export function icon(name, { label, className = '' } = {}) {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', `icon ${className}`.trim());
  svg.setAttribute('focusable', 'false');
  if (label) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label); } else svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(SVG_NS, 'use');
  use.setAttribute('href', `/icons/sprite.svg#i-${name}`);
  svg.append(use);
  return svg;
}

const TOAST_ICON = { success: 'circle-check', error: 'triangle-alert' };

export function toast(message, kind = 'info', ms = 3500) {
  const box = document.getElementById('toasts');
  // The kind is the icon (and the border color); the text says what happened.
  const node = el('div', { class: `toast ${kind}` }, TOAST_ICON[kind] && icon(TOAST_ICON[kind]), el('span', {}, message));
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
  // Deferred autofocus, but never steal focus from a field the user already
  // moved to: within those 30 ms, typing into the 2nd field landed in the 1st
  // (found by the clone E2E: the target path ended up in the URL field).
  if (first) setTimeout(() => { if (!modal.contains(document.activeElement)) first.focus(); }, 30);
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

/* ---- file icons: a generic glyph per CATEGORY, not language logos ----
   Logos are trademarks and their colors fought the git status colors (M/U/D),
   which are what matters here; the extension is already in the name. */
const CATEGORY = {
  code: 'js mjs cjs ts tsx jsx html css scss py rb go rs java php c h cpp cs kt swift vue svelte',
  json: 'json',
  text: 'md txt pdf rst',
  image: 'png jpg jpeg gif svg ico webp',
  archive: 'zip gz tgz tar',
  cog: 'yml yaml toml ini gitignore gitattributes editorconfig',
  terminal: 'sh bash zsh',
  lock: 'lock',
  key: 'env pem key',
  spreadsheet: 'csv tsv xlsx',
};
const EXT_ICON = Object.fromEntries(Object.entries(CATEGORY)
  .flatMap(([cat, exts]) => exts.split(' ').map((ext) => [ext, `file-${cat === 'text' ? 'text' : cat}`])));

export function fileIcon(name, type, expanded = false) {
  if (type === 'dir') return icon(expanded ? 'folder-open' : 'folder', { className: 'file-icon' });
  const ext = name.split('.').pop().toLowerCase();
  return icon(EXT_ICON[ext] || 'file', { className: 'file-icon' });
}

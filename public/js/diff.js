import { el } from './ui.js';

/** Render server-produced side-by-side rows into a table. */
export function renderDiff(rows) {
  const cell = (side) => [
    el('td', { class: 'ln' }, side ? String(side.ln) : ''),
    el('td', { class: `half ${side ? side.type : ''}` }, side ? side.text : ''),
  ];
  const table = el('table', { class: 'diff-table' },
    rows.map((row) => el('tr', {}, ...cell(row.left), ...cell(row.right))),
  );
  if (rows.length === 0) {
    return el('p', { class: 'muted pad' }, 'No differences.');
  }
  return table;
}

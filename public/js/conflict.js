import { el } from './ui.js';

/**
 * Visual merge-conflict editor.
 * Parses conflict markers into segments and renders each conflict as a
 * card with both sides in parallel; the user picks per conflict.
 */

/** → [{type:'ctx', lines} | {type:'conflict', ours, theirs, oursLabel, theirsLabel, choice, custom}] */
export function parseConflicts(text) {
  const lines = text.split('\n');
  const segments = [];
  let ctx = [];
  let i = 0;
  const flushCtx = () => { if (ctx.length) segments.push({ type: 'ctx', lines: ctx }); ctx = []; };

  while (i < lines.length) {
    if (lines[i].startsWith('<<<<<<<')) {
      flushCtx();
      const oursLabel = lines[i].slice(7).trim();
      const ours = [];
      const theirs = [];
      let theirsLabel = '';
      i++;
      while (i < lines.length && !lines[i].startsWith('=======')) ours.push(lines[i++]);
      i++; // skip =======
      while (i < lines.length && !lines[i].startsWith('>>>>>>>')) theirs.push(lines[i++]);
      if (i < lines.length) theirsLabel = lines[i++].slice(7).trim();
      segments.push({ type: 'conflict', ours, theirs, oursLabel, theirsLabel, choice: null, custom: '' });
    } else {
      ctx.push(lines[i++]);
    }
  }
  flushCtx();
  return segments;
}

const resolution = (seg) => ({
  ours: seg.ours,
  theirs: seg.theirs,
  both: [...seg.ours, ...seg.theirs],
  custom: seg.custom.split('\n'),
}[seg.choice]);

/** Join segments back into file content. Unresolved conflicts keep their markers. */
export function assembleConflicts(segments) {
  const out = [];
  let unresolved = 0;
  for (const seg of segments) {
    if (seg.type === 'ctx') { out.push(...seg.lines); continue; }
    if (!seg.choice) {
      unresolved++;
      out.push(`<<<<<<< ${seg.oursLabel}`, ...seg.ours, '=======', ...seg.theirs, `>>>>>>> ${seg.theirsLabel}`);
    } else {
      out.push(...resolution(seg));
    }
  }
  return { text: out.join('\n'), unresolved };
}

const CTX_PREVIEW = 3;

function ctxNode(seg) {
  if (seg.lines.length <= CTX_PREVIEW * 2 + 1) {
    return el('pre', { class: 'cf-ctx' }, seg.lines.join('\n'));
  }
  const head = el('pre', { class: 'cf-ctx' }, seg.lines.slice(0, CTX_PREVIEW).join('\n'));
  const tail = el('pre', { class: 'cf-ctx' }, seg.lines.slice(-CTX_PREVIEW).join('\n'));
  const hidden = seg.lines.length - CTX_PREVIEW * 2;
  const expand = el('button', {
    class: 'cf-expand',
    onclick: () => wrap.replaceWith(el('pre', { class: 'cf-ctx' }, seg.lines.join('\n'))),
  }, `⋯ show ${hidden} unchanged lines ⋯`);
  const wrap = el('div', {}, head, expand, tail);
  return wrap;
}

function conflictNode(seg, index, total, names, onChange) {
  const paneText = (lines) => lines.length ? lines.join('\n') : '∅ (empty — this side deletes these lines)';

  const block = el('div', { class: 'cf-block' });
  const customArea = el('textarea', { class: 'cf-custom', spellcheck: 'false', hidden: true });
  customArea.addEventListener('input', () => { seg.custom = customArea.value; onChange(); });

  const pick = (choice) => () => {
    seg.choice = seg.choice === choice ? null : choice; // click again to unpick
    if (seg.choice === 'custom') {
      customArea.value = seg.custom || [...seg.ours, ...seg.theirs].join('\n');
      seg.custom = customArea.value;
    }
    customArea.hidden = seg.choice !== 'custom';
    block.dataset.choice = seg.choice || '';
    buttons.forEach(([b, c]) => b.classList.toggle('btn-primary', seg.choice === c));
    onChange();
  };

  const buttons = [
    [el('button', { class: 'btn btn-xs', onclick: pick('ours') }, '← Keep local'), 'ours'],
    [el('button', { class: 'btn btn-xs', onclick: pick('theirs') }, 'Take incoming →'), 'theirs'],
    [el('button', { class: 'btn btn-xs', onclick: pick('both') }, '⇵ Both'), 'both'],
    [el('button', { class: 'btn btn-xs', onclick: pick('custom') }, '✏️ Edit'), 'custom'],
  ];

  block.append(
    el('div', { class: 'cf-block-head' },
      el('strong', {}, `⚡ Conflict ${index + 1} of ${total}`),
      el('span', { class: 'spacer' }),
      ...buttons.map(([b]) => b),
    ),
    el('div', { class: 'cf-panes' },
      el('div', { class: 'cf-col' },
        el('div', { class: 'cf-pane-head ours' }, `● LOCAL — ${seg.oursLabel || names.ours || 'yours'}`),
        el('pre', { class: 'cf-pane ours' }, paneText(seg.ours)),
      ),
      el('div', { class: 'cf-col' },
        el('div', { class: 'cf-pane-head theirs' }, `● INCOMING — ${seg.theirsLabel || names.theirs || 'theirs'}`),
        el('pre', { class: 'cf-pane theirs' }, paneText(seg.theirs)),
      ),
    ),
    customArea,
  );
  return block;
}

/**
 * Render the whole editor into `container`.
 * `names` = { ours, theirs } branch names; `onChange(unresolved, total)` fires on every pick.
 */
export function renderConflictUI(container, segments, names, onChange) {
  const conflicts = segments.filter((s) => s.type === 'conflict');
  const notify = () => onChange(conflicts.filter((c) => !c.choice).length, conflicts.length);
  let n = 0;
  container.replaceChildren(...segments.map((seg) =>
    seg.type === 'ctx' ? ctxNode(seg) : conflictNode(seg, n++, conflicts.length, names, notify),
  ));
  notify();
}

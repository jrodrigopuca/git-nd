const COLORS = ['#4f9cf9', '#4dbd74', '#d8b04c', '#e5605e', '#b57edc', '#5bc8c4', '#e08e4e'];
const ROW_H = 28;
const COL_W = 16;

/**
 * Assign a lane (column) to every commit so branches/merges render as
 * parallel colored lines. Standard "active lanes" sweep over topo order.
 */
function computeLanes(commits) {
  const lane = new Map();
  const active = []; // active[i] = next oid expected on that lane

  for (const c of commits) {
    let li = active.indexOf(c.oid);
    if (li === -1) {
      li = active.indexOf(null);
      if (li === -1) { active.push(null); li = active.length - 1; }
    }
    for (let i = 0; i < active.length; i++) {
      if (active[i] === c.oid && i !== li) active[i] = null; // merged lanes close here
    }
    lane.set(c.oid, li);
    active[li] = c.parents[0] || null;
    for (const p of c.parents.slice(1)) {
      if (!active.includes(p)) {
        const free = active.indexOf(null);
        if (free === -1) active.push(p); else active[free] = p;
      }
    }
  }
  return { lane, maxLanes: Math.max(1, active.length) };
}

const svgEl = (tag, attrs) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const labelWidth = (name) => name.length * 6.4 + 16;

export function renderGraph(commits, { onSelect, tips = {}, headOid = null } = {}) {
  const { lane, maxLanes } = computeLanes(commits);
  const row = new Map(commits.map((c, i) => [c.oid, i]));
  const textX = maxLanes * COL_W + 20;
  const width = Math.max(600, textX + 640);
  const height = commits.length * ROW_H + 10;

  const svg = svgEl('svg', { width, height, viewBox: `0 0 ${width} ${height}` });
  const cx = (l) => 10 + l * COL_W;
  const cy = (r) => 18 + r * ROW_H;

  // Edges first (behind the dots)
  for (const c of commits) {
    const [x1, y1] = [cx(lane.get(c.oid)), cy(row.get(c.oid))];
    for (const p of c.parents) {
      if (row.has(p)) {
        const [x2, y2] = [cx(lane.get(p)), cy(row.get(p))];
        const d = x1 === x2
          ? `M${x1},${y1} L${x2},${y2}`
          : `M${x1},${y1} C${x1},${y1 + ROW_H * 0.8} ${x2},${y2 - ROW_H * 0.8} ${x2},${y2}`;
        svg.append(svgEl('path', {
          d, fill: 'none', 'stroke-width': 2,
          stroke: COLORS[lane.get(p) % COLORS.length],
        }));
      } else {
        svg.append(svgEl('path', {
          d: `M${x1},${y1} L${x1},${y1 + ROW_H * 0.7}`,
          fill: 'none', 'stroke-width': 2, 'stroke-dasharray': '2,3',
          stroke: COLORS[lane.get(c.oid) % COLORS.length],
        }));
      }
    }
  }

  // Rows: hover rect + dot + branch labels + text
  commits.forEach((c, i) => {
    const g = svgEl('g', { class: 'graph-row', style: 'cursor:pointer' });
    g.append(svgEl('rect', { x: 0, y: cy(i) - ROW_H / 2, width, height: ROW_H, fill: 'transparent' }));

    const isHead = c.oid === headOid;
    g.append(svgEl('circle', {
      cx: cx(lane.get(c.oid)), cy: cy(i), r: isHead ? 6 : 4.5,
      fill: COLORS[lane.get(c.oid) % COLORS.length],
      stroke: isHead || c.parents.length > 1 ? 'var(--fg)' : 'none',
      'stroke-width': isHead ? 2 : 1.5,
    }));

    let x = textX;
    for (const t of (tips[c.oid] || [])) {
      const w = labelWidth(t.name);
      const color = t.current ? 'var(--accent)' : COLORS[lane.get(c.oid) % COLORS.length];
      g.append(svgEl('rect', {
        x, y: cy(i) - 9, width: w, height: 18, rx: 9,
        fill: t.current ? color : 'transparent',
        stroke: color, 'stroke-width': 1.2,
        'stroke-dasharray': t.remote ? '3,2' : 'none',
      }));
      const label = svgEl('text', {
        x: x + w / 2, y: cy(i) + 3.5, 'text-anchor': 'middle',
        style: `font-size:10.5px; fill: ${t.current ? 'var(--accent-fg)' : 'var(--fg)'}`,
      });
      label.textContent = t.name;
      g.append(label);
      x += w + 6;
    }

    const msg = svgEl('text', { x, y: cy(i) + 4, class: 'graph-msg' });
    msg.textContent = c.message.split('\n')[0].slice(0, 70);
    const meta = svgEl('text', { x: textX + 460, y: cy(i) + 4, class: 'graph-meta' });
    meta.textContent = `${c.oid.slice(0, 7)} · ${c.author} · ${new Date(c.date).toLocaleDateString()}`;
    g.append(msg, meta);
    if (onSelect) g.addEventListener('click', () => onSelect(c));
    svg.append(g);
  });

  return svg;
}

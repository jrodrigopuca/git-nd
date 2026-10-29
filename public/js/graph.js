const COLORS = ['#4f9cf9', '#4dbd74', '#d8b04c', '#e5605e', '#b57edc', '#5bc8c4', '#e08e4e'];
const ROW_H = 28;
const COL_W = 16;
const LANE_HEADROOM = 4; // spare lanes so later pages rarely force a re-layout
const META_W = 150;      // reserved width for "hash · date" at the right edge

const svgEl = (tag, attrs) => {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

const labelWidth = (name) => name.length * 6.4 + 16;

/* Author avatar: initials on a circle, color hashed from the email so the
   same person always gets the same color across sessions and repos. */
const AVATAR_COLORS = ['#5b8def', '#3fa66a', '#c2913a', '#c95d5b', '#9b6fc9', '#3fa9a5', '#c97a45', '#7287d6'];

function authorColor(email) {
  let h = 0;
  for (const ch of email || '?') h = (h * 31 + ch.codePointAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

function initials(name) {
  const words = (name || '?').trim().split(/\s+/);
  return ((words[0]?.[0] || '') + (words[1]?.[0] || '')).toUpperCase() || '?';
}

/**
 * Commit graph that grows page by page (docs/adr/0001). Rows arrive in the
 * server's append-only order, so:
 * - lanes continue from where the previous page left them (same single
 *   top-to-bottom sweep as before, just resumable);
 * - an edge to a parent not loaded yet is a dashed stub, replaced by the real
 *   edge when that parent arrives on a later page;
 * - tags arrive after the first page and redraw only the rows they touch.
 * Only when the lanes outgrow the reserved width is everything laid out again.
 */
export class GraphView {
  constructor({ onSelect } = {}) {
    this.onSelect = onSelect;
    this.element = document.createElement('div');
  }

  /** Start over with a first page. */
  reset(commits, { tips = {}, headOid = null } = {}) {
    this.branchTips = tips;     // oid → [{ name, remote, current }]
    this.tagTips = {};          // oid → [{ name, tag: true }]
    this.headOid = headOid;
    this.layout(commits, null);
    return this.element;
  }

  /** Add the next page below the rows already drawn. */
  append(commits) {
    const before = this.commits.length;
    this.place(commits);
    if (this.lanesUsed > this.reservedLanes) this.layout(this.commits, null); // rare: re-layout all
    else this.resize();
    return this.commits.length - before;
  }

  /** Tags (`{ oid: [name] }`): redraw the loaded rows they touch; later pages pick them up. */
  setTags(tags) {
    this.tagTips = {};
    for (const [oid, names] of Object.entries(tags)) this.tagTips[oid] = names.map((name) => ({ name, tag: true }));
    for (const oid of Object.keys(this.tagTips)) {
      const old = this.rowEls.get(oid);
      if (old) old.replaceWith(this.renderRow(this.commits[this.row.get(oid)], this.row.get(oid)));
    }
  }

  get size() { return this.commits.length; }

  /* ---- internals ---- */

  layout(commits, reserved) {
    this.commits = [];
    this.lane = new Map();
    this.row = new Map();
    this.rowEls = new Map();
    this.active = [];        // active[i] = oid expected next on lane i
    this.lanesUsed = 1;
    this.pending = new Map(); // parent oid → [{ child, stub }] edges waiting for that parent

    // Lanes first (cheap, no DOM) to size the lane column before drawing.
    const probe = new Map();
    const active = [];
    let used = 1;
    // `probe` doubles as the "placed" set: it holds every commit swept so far.
    for (const c of commits) used = Math.max(used, this.assignLane(c, active, probe, probe));
    this.reservedLanes = reserved ?? used + LANE_HEADROOM;

    this.textX = this.reservedLanes * COL_W + 20;
    this.width = Math.max(600, this.textX + 640);
    this.metaX = this.width - META_W;
    this.svg = svgEl('svg', {});
    this.edgesLayer = svgEl('g', {});
    this.rowsLayer = svgEl('g', {});
    this.svg.append(this.edgesLayer, this.rowsLayer);
    this.element.replaceChildren(this.svg);
    this.place(commits);
    this.resize();
  }

  resize() {
    const height = this.commits.length * ROW_H + 10;
    this.svg.setAttribute('width', this.width);
    this.svg.setAttribute('height', height);
    this.svg.setAttribute('viewBox', `0 0 ${this.width} ${height}`);
  }

  /**
   * One step of the active-lanes sweep for commit `c`. A parent already placed
   * (clock skew put it above its child) is not reserved: it would hold a lane
   * open down to the bottom of the graph.
   */
  assignLane(c, active, lane, placed) {
    let li = active.indexOf(c.oid);
    if (li === -1) {
      li = active.indexOf(null);
      if (li === -1) { active.push(null); li = active.length - 1; }
    }
    for (let i = 0; i < active.length; i++) {
      if (active[i] === c.oid && i !== li) active[i] = null; // merged lanes close here
    }
    lane.set(c.oid, li);
    const [first, ...others] = c.parents;
    active[li] = first && !placed.has(first) ? first : null;
    for (const p of others) {
      if (placed.has(p) || active.includes(p)) continue;
      const free = active.indexOf(null);
      if (free === -1) active.push(p); else active[free] = p;
    }
    return Math.max(1, active.length);
  }

  place(commits) {
    for (const c of commits) {
      const i = this.commits.length;
      this.commits.push(c);
      this.row.set(c.oid, i);
      this.lanesUsed = Math.max(this.lanesUsed, this.assignLane(c, this.active, this.lane, this.row));

      for (const p of c.parents) {
        if (this.row.has(p)) this.edgesLayer.append(this.edge(c.oid, p)); // parent above (skew)
        else {
          const stub = this.stub(c.oid);
          this.edgesLayer.append(stub);
          if (!this.pending.has(p)) this.pending.set(p, []);
          this.pending.get(p).push({ child: c.oid, stub });
        }
      }
      for (const { child, stub } of this.pending.get(c.oid) || []) stub.replaceWith(this.edge(child, c.oid));
      this.pending.delete(c.oid);

      const g = this.renderRow(c, i);
      this.rowsLayer.append(g);
    }
  }

  cx(l) { return 10 + l * COL_W; }
  cy(r) { return 18 + r * ROW_H; }

  edge(childOid, parentOid) {
    const [x1, y1] = [this.cx(this.lane.get(childOid)), this.cy(this.row.get(childOid))];
    const [x2, y2] = [this.cx(this.lane.get(parentOid)), this.cy(this.row.get(parentOid))];
    const d = x1 === x2
      ? `M${x1},${y1} L${x2},${y2}`
      : `M${x1},${y1} C${x1},${y1 + ROW_H * 0.8} ${x2},${y2 - ROW_H * 0.8} ${x2},${y2}`;
    return svgEl('path', {
      d, fill: 'none', 'stroke-width': 2,
      stroke: COLORS[this.lane.get(parentOid) % COLORS.length],
    });
  }

  /** Parent not loaded yet: short dashed line going down. */
  stub(childOid) {
    const [x, y] = [this.cx(this.lane.get(childOid)), this.cy(this.row.get(childOid))];
    return svgEl('path', {
      d: `M${x},${y} L${x},${y + ROW_H * 0.7}`,
      fill: 'none', 'stroke-width': 2, 'stroke-dasharray': '2,3',
      stroke: COLORS[this.lane.get(childOid) % COLORS.length],
    });
  }

  renderRow(c, i) {
    const { width, textX, metaX } = this;
    const cy = this.cy(i);
    const laneIdx = this.lane.get(c.oid);
    const g = svgEl('g', { class: 'graph-row', style: 'cursor:pointer' });
    g.append(svgEl('rect', { x: 0, y: cy - ROW_H / 2, width, height: ROW_H, fill: 'transparent' }));

    const isHead = c.oid === this.headOid;
    g.append(svgEl('circle', {
      cx: this.cx(laneIdx), cy, r: isHead ? 6 : 4.5,
      fill: COLORS[laneIdx % COLORS.length],
      stroke: isHead || c.parents.length > 1 ? 'var(--fg)' : 'none',
      'stroke-width': isHead ? 2 : 1.5,
    }));

    // Author avatar: initials chip, hover for full name/email.
    const av = svgEl('g', {});
    av.append(svgEl('circle', { cx: textX + 9, cy, r: 9, fill: authorColor(c.email) }));
    const avText = svgEl('text', {
      x: textX + 9, y: cy + 3, 'text-anchor': 'middle',
      style: 'font-size:8.5px; font-weight:700; fill:#fff; pointer-events:none',
    });
    avText.textContent = initials(c.author);
    const avTitle = svgEl('title', {});
    avTitle.textContent = `${c.author} <${c.email}>`;
    av.append(avText, avTitle);
    g.append(av);

    let x = textX + 26;
    const chipLimit = metaX - 10; // chips must not cross into the hash/date column
    const drawChip = (shown, tooltip, { color, current = false, remote = false }) => {
      const w = labelWidth(shown);
      const chip = svgEl('g', {});
      chip.append(svgEl('rect', {
        x, y: cy - 9, width: w, height: 18, rx: 9,
        fill: current ? color : 'transparent',
        stroke: color, 'stroke-width': 1.2,
        'stroke-dasharray': remote ? '3,2' : 'none',
      }));
      const label = svgEl('text', {
        x: x + w / 2, y: cy + 3.5, 'text-anchor': 'middle',
        style: `font-size:10.5px; fill: ${current ? 'var(--accent-fg)' : 'var(--fg)'}`,
      });
      label.textContent = shown;
      chip.append(label);
      if (tooltip) {
        const tip = svgEl('title', {});
        tip.textContent = tooltip;
        chip.append(tip);
      }
      g.append(chip);
      x += w + 6;
    };
    const rowTips = [...(this.branchTips[c.oid] || []), ...(this.tagTips[c.oid] || [])];
    for (let k = 0; k < rowTips.length; k++) {
      const t = rowTips[k];
      // Long branch names (dependabot/…) get truncated; full name in tooltip.
      const raw = t.tag ? `🏷 ${t.name}` : t.name;
      const shown = raw.length > 24 ? `${raw.slice(0, 11)}…${raw.slice(-11)}` : raw;
      // If more chips follow, keep room for the "+N" overflow chip.
      const reserve = k < rowTips.length - 1 ? labelWidth('+99') + 6 : 0;
      if (x + labelWidth(shown) > chipLimit - reserve) {
        // Too many refs on this commit: collapse the rest into "+N", names in tooltip.
        const rest = rowTips.slice(k);
        drawChip(`+${rest.length}`, rest.map((r) => r.name).join('\n'), { color: 'var(--muted)' });
        break;
      }
      const color = t.tag ? 'var(--yellow)' : t.current ? 'var(--accent)' : COLORS[laneIdx % COLORS.length];
      drawChip(shown, shown !== raw ? t.name : null, { color, current: t.current, remote: t.remote });
    }

    // Fit the message into the real space left before the meta zone, so long
    // messages + branch chips never overlap the hash/date column.
    const AVG_CHAR_PX = 6.6; // approx glyph width for the message font
    const MIN_MSG_CHARS = 5; // below this a stub like "a…" says nothing: hide it
    const avail = metaX - 10 - x;
    const firstLine = c.message.split('\n')[0];
    const msg = svgEl('text', { x, y: cy + 4, class: 'graph-msg' });
    if (avail < MIN_MSG_CHARS * AVG_CHAR_PX) {
      // No room: hide the message. The tooltip goes on the ROW, not on the
      // empty <text> — an SVG text with no glyphs has no hover area at all.
      // Inner <title>s (avatar, chips) still win over it where they apply.
      const tip = svgEl('title', {});
      tip.textContent = firstLine;
      g.append(tip);
    } else {
      const maxChars = Math.floor(avail / AVG_CHAR_PX);
      const truncated = firstLine.length > maxChars;
      msg.textContent = truncated ? `${firstLine.slice(0, maxChars - 1)}…` : firstLine;
      if (truncated) {
        const tip = svgEl('title', {});
        tip.textContent = firstLine;
        msg.append(tip);
      }
    }
    // Author lives in the avatar; keep the meta line lean. Anchored to the
    // right edge so it stays put regardless of message/chip length.
    const meta = svgEl('text', { x: width - 10, y: cy + 4, 'text-anchor': 'end', class: 'graph-meta' });
    meta.textContent = `${c.oid.slice(0, 7)} · ${new Date(c.date).toLocaleDateString()}`;
    g.append(msg, meta);
    if (this.onSelect) g.addEventListener('click', () => this.onSelect(c));
    this.rowEls.set(c.oid, g);
    return g;
  }
}

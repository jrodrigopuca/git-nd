const COLORS = ['#4f9cf9', '#4dbd74', '#d8b04c', '#e5605e', '#b57edc', '#5bc8c4', '#e08e4e'];
const ROW_H = 28;
const COL_W = 16;
const LANE_HEADROOM = 4; // spare lanes so later pages rarely move the text column
const META_W = 150;      // reserved width for "hash · date" at the right edge
const OVERSCAN = 20;     // rows drawn above and below the viewport

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
 * Commit graph that grows page by page and draws only what is on screen
 * (docs/adr/0001).
 *
 * Model (all loaded commits, cheap): rows in the server's append-only order,
 * lanes from a resumable top-to-bottom sweep, and edges child → parent.
 * An edge to a parent not loaded yet is drawn as a dashed stub until that
 * parent arrives on a later page.
 *
 * View (virtualized): the SVG keeps the full height, so the scrollbar is
 * honest, but only rows in the viewport ± OVERSCAN, and the edges crossing
 * that band, are in the DOM. Drawing 14k rows as DOM made each "Load more"
 * cost 2.6 s in the browser; now the DOM size does not depend on history size.
 */
export class GraphView {
  /** @param {{ onSelect?: (c) => void, scroller: HTMLElement }} opts — scroller: the element that scrolls */
  constructor({ onSelect, scroller } = {}) {
    this.onSelect = onSelect;
    this.scroller = scroller;
    this.element = document.createElement('div');
    this.frame = 0;
    this.onScroll = () => this.schedule();
    this.resizeObserver = new ResizeObserver(() => this.schedule()); // also fires when the tab becomes visible
  }

  /** Start over with a first page. */
  reset(commits, { tips = {}, headOid = null } = {}) {
    this.branchTips = tips;     // oid → [{ name, remote, current }]
    this.tagTips = {};          // oid → [{ name, tag: true }]
    this.headOid = headOid;
    this.commits = [];
    this.lane = new Map();
    this.row = new Map();
    this.active = [];           // active[i] = oid expected next on lane i
    this.lanesUsed = 1;
    this.edges = [];            // { key, child, parent } once both rows exist
    this.waiting = new Map();   // parent oid not loaded yet → [child oid]
    this.drawnRows = new Map(); // row index → <g>
    this.drawnEdges = new Map(); // key → <path>
    // Roving tabindex (BACKLOG B-24): the whole graph is ONE tab stop — the
    // active row has tabindex 0, every other row -1 — and ↑/↓ move between
    // rows, scrolling the virtual list. Tabbing through thousands of rows
    // would make the rest of the page unreachable.
    this.activeRow = 0;

    this.svg = svgEl('svg', {});
    this.edgesLayer = svgEl('g', {});
    this.rowsLayer = svgEl('g', {});
    this.svg.append(this.edgesLayer, this.rowsLayer);
    this.element.replaceChildren(this.svg);

    this.place(commits);
    this.setTextColumn(this.lanesUsed + LANE_HEADROOM);
    this.attach();
    this.update(); // synchronous first draw: the page is visible right away
    return this.element;
  }

  /** Add the next page below the rows already loaded. */
  append(commits) {
    const before = this.commits.length;
    this.place(commits);
    if (this.lanesUsed > this.reservedLanes) {
      // Lanes outgrew the reserved column: move the text, redraw visible rows.
      this.setTextColumn(this.lanesUsed + LANE_HEADROOM);
      for (const g of this.drawnRows.values()) g.remove();
      this.drawnRows.clear();
    }
    this.resize();
    this.update();
    return this.commits.length - before;
  }

  /** Tags (`{ oid: [name] }`): visible rows are redrawn now, the rest when scrolled into view. */
  setTags(tags) {
    this.tagTips = {};
    for (const [oid, names] of Object.entries(tags)) this.tagTips[oid] = names.map((name) => ({ name, tag: true }));
    for (const [i, g] of this.drawnRows) {
      const hadFocus = g === document.activeElement;
      const fresh = this.drawRow(i);
      g.replaceWith(fresh);
      this.drawnRows.set(i, fresh); // keep the registry pointing at what is in the DOM
      if (hadFocus) fresh.focus({ preventScroll: true });
    }
  }

  /** Keyboard: make row `i` the active one, bring it into view, draw it, focus it. */
  focusRow(i) {
    const n = this.commits.length;
    if (!n) return;
    i = Math.max(0, Math.min(n - 1, i));
    this.setActiveRow(i);
    const sc = this.scroller;
    if (sc) {
      const svgTop = this.svg.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
      const top = svgTop + 4 + i * ROW_H;
      const bottom = svgTop + 32 + i * ROW_H;
      if (top < sc.scrollTop) sc.scrollTop = top;
      else if (bottom > sc.scrollTop + sc.clientHeight) sc.scrollTop = bottom - sc.clientHeight;
    }
    this.update(); // synchronously: the row must exist before it can take focus
    this.drawnRows.get(i)?.focus({ preventScroll: true });
  }

  setActiveRow(i) {
    if (i === this.activeRow) return;
    this.drawnRows.get(this.activeRow)?.setAttribute('tabindex', '-1');
    this.activeRow = i;
    this.drawnRows.get(i)?.setAttribute('tabindex', '0');
  }

  /** Stop listening (the view is being replaced). */
  destroy() {
    this.scroller?.removeEventListener('scroll', this.onScroll);
    this.resizeObserver.disconnect();
    cancelAnimationFrame(this.frame);
  }

  get size() { return this.commits.length; }

  /* ---- model ---- */

  /** Lanes + edges for new commits. No DOM. */
  place(commits) {
    for (const c of commits) {
      const i = this.commits.length;
      this.commits.push(c);
      this.row.set(c.oid, i);
      this.lanesUsed = Math.max(this.lanesUsed, this.assignLane(c));
      for (const p of c.parents) {
        // Parent already above (clock skew): the edge exists now. Otherwise it
        // is created when the parent's row arrives (children are seen first).
        if (this.row.has(p)) this.edges.push({ key: `${c.oid}>${p}`, child: c.oid, parent: p });
      }
      for (const childOid of this.waiting.get(c.oid) || []) {
        this.edges.push({ key: `${childOid}>${c.oid}`, child: childOid, parent: c.oid });
      }
      this.waiting.delete(c.oid);
      for (const p of c.parents) {
        if (this.row.has(p)) continue;
        if (!this.waiting.has(p)) this.waiting.set(p, []);
        this.waiting.get(p).push(c.oid);
      }
    }
  }

  /**
   * One step of the active-lanes sweep. A parent already placed (clock skew
   * put it above its child) is not reserved: it would hold a lane open down
   * to the bottom of the graph.
   */
  assignLane(c) {
    const { active } = this;
    let li = active.indexOf(c.oid);
    if (li === -1) {
      li = active.indexOf(null);
      if (li === -1) { active.push(null); li = active.length - 1; }
    }
    for (let i = 0; i < active.length; i++) {
      if (active[i] === c.oid && i !== li) active[i] = null; // merged lanes close here
    }
    this.lane.set(c.oid, li);
    const [first, ...others] = c.parents;
    active[li] = first && !this.row.has(first) ? first : null;
    for (const p of others) {
      if (this.row.has(p) || active.includes(p)) continue;
      const free = active.indexOf(null);
      if (free === -1) active.push(p); else active[free] = p;
    }
    return Math.max(1, active.length);
  }

  /* ---- view ---- */

  setTextColumn(lanes) {
    this.reservedLanes = lanes;
    this.textX = lanes * COL_W + 20;
    this.width = Math.max(600, this.textX + 640);
    this.metaX = this.width - META_W;
    this.resize();
  }

  resize() {
    const height = this.commits.length * ROW_H + 10;
    this.svg.setAttribute('width', this.width);
    this.svg.setAttribute('height', height);
    this.svg.setAttribute('viewBox', `0 0 ${this.width} ${height}`);
  }

  attach() {
    if (!this.scroller) return;
    this.scroller.addEventListener('scroll', this.onScroll, { passive: true });
    this.resizeObserver.observe(this.scroller);
  }

  schedule() {
    if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.update(); });
  }

  /** Row indexes to draw: viewport ± OVERSCAN (first rows if not measurable yet). */
  visibleRange() {
    const n = this.commits.length;
    const sc = this.scroller;
    if (!sc || !sc.clientHeight || !this.svg.isConnected) return [0, Math.min(n, 2 * OVERSCAN) - 1];
    const svgTop = this.svg.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    const y0 = sc.scrollTop - svgTop;
    const y1 = y0 + sc.clientHeight;
    // Row r occupies [4 + r*ROW_H, 32 + r*ROW_H] (cy = 18 + r*ROW_H ± ROW_H/2).
    const first = Math.max(0, Math.floor((y0 - 4) / ROW_H) - OVERSCAN);
    const last = Math.min(n - 1, Math.ceil((y1 - 4) / ROW_H) + OVERSCAN);
    return [first, last];
  }

  /** Index of the first row actually on screen (no overscan). */
  firstVisibleRow() {
    const sc = this.scroller;
    if (!sc || !sc.clientHeight || !this.svg.isConnected) return 0;
    const svgTop = this.svg.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop;
    return Math.max(0, Math.ceil((sc.scrollTop - svgTop - 4) / ROW_H));
  }

  /** Bring the DOM in line with the visible range: add what entered, drop what left. */
  update() {
    if (!this.commits.length) return;
    const [first, last] = this.visibleRange();

    const focusedInGraph = this.svg.contains(document.activeElement);
    for (const [i, g] of this.drawnRows) {
      // Never drop the row holding keyboard focus: focus would fall to <body>.
      if ((i < first || i > last) && g !== document.activeElement) { g.remove(); this.drawnRows.delete(i); }
    }
    // The single tab stop must exist: if the active row scrolled away (and
    // focus is not in the graph), the first row on screen becomes active.
    if (!focusedInGraph && (this.activeRow < first || this.activeRow > last)) {
      this.activeRow = Math.min(last, Math.max(first, this.firstVisibleRow()));
      for (const [i, g] of this.drawnRows) g.setAttribute('tabindex', i === this.activeRow ? '0' : '-1');
    }
    for (let i = first; i <= last; i++) {
      if (!this.drawnRows.has(i)) {
        const g = this.drawRow(i);
        this.rowsLayer.append(g);
        this.drawnRows.set(i, g);
      }
    }

    // Edges crossing the band (a long lane line can start far above it), plus
    // stubs for visible rows whose parent is not loaded yet.
    const wanted = new Map();
    for (const e of this.edges) {
      const a = this.row.get(e.child);
      const b = this.row.get(e.parent);
      if (Math.max(a, b) >= first && Math.min(a, b) <= last) wanted.set(e.key, e);
    }
    for (let i = first; i <= last; i++) {
      const c = this.commits[i];
      for (const p of c.parents) if (!this.row.has(p)) wanted.set(`stub:${c.oid}>${p}`, { stub: c.oid });
    }
    for (const [key, path] of this.drawnEdges) {
      if (!wanted.has(key)) { path.remove(); this.drawnEdges.delete(key); }
    }
    for (const [key, e] of wanted) {
      if (this.drawnEdges.has(key)) continue;
      const path = e.stub ? this.drawStub(e.stub) : this.drawEdge(e.child, e.parent);
      this.edgesLayer.append(path);
      this.drawnEdges.set(key, path);
    }
  }

  cx(l) { return 10 + l * COL_W; }
  cy(r) { return 18 + r * ROW_H; }

  drawEdge(childOid, parentOid) {
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
  drawStub(childOid) {
    const [x, y] = [this.cx(this.lane.get(childOid)), this.cy(this.row.get(childOid))];
    return svgEl('path', {
      d: `M${x},${y} L${x},${y + ROW_H * 0.7}`,
      fill: 'none', 'stroke-width': 2, 'stroke-dasharray': '2,3',
      stroke: COLORS[this.lane.get(childOid) % COLORS.length],
    });
  }

  drawRow(i) {
    const c = this.commits[i];
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
    if (this.onSelect) g.addEventListener('click', () => { this.setActiveRow(i); this.onSelect(c); });
    // Keyboard (BACKLOG B-24): one tab stop (roving tabindex), ↑/↓ to move,
    // Enter/Space to open the commit.
    g.setAttribute('tabindex', i === this.activeRow ? '0' : '-1');
    g.setAttribute('role', 'button');
    g.setAttribute('aria-label', `${firstLine} — ${c.oid.slice(0, 7)} by ${c.author}`);
    g.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.focusRow(i + (e.key === 'ArrowDown' ? 1 : -1));
      } else if ((e.key === 'Enter' || e.key === ' ') && this.onSelect) {
        e.preventDefault();
        this.onSelect(c);
      }
    });
    return g;
  }
}

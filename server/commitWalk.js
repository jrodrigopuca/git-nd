import fs from 'node:fs';
import git from 'isomorphic-git';

/**
 * Commit-graph walks over isomorphic-git, without fixed-size windows.
 *
 * Comparing two `git.log({ depth: N })` windows breaks as soon as the branches
 * are more than N commits apart (a branch 350 behind looked "ahead 50, behind
 * 50", and Pull --rebase missed the fast-forward). These walks go as deep as
 * the graph requires and stop at the common history.
 */

/** Max-heap of commits keyed on committer timestamp (git's date order). */
export class CommitHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(entry) {
    const a = this.items;
    a.push(entry);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].ts >= a[i].ts) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].ts > a[m].ts) m = l;
        if (r < a.length && a[r].ts > a[m].ts) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const LEFT = 1;
const RIGHT = 2;
const BOTH = LEFT | RIGHT;

/**
 * Commits reachable from `left` but not `right`, and vice versa — what
 * `git rev-list left...right` would list on each side. Results are newest
 * first, in the same `{ oid, commit }` shape `git.log` returns.
 *
 * Walks newest-first by committer date, painting each commit with the
 * side(s) it is reachable from, and stops once every queued commit is
 * reachable from both sides. Dates are only a heuristic: equal timestamps
 * (a rebased series, scripted commits) or clock skew can pop a parent before
 * its child. When a commit already popped later turns out to be reachable
 * from both sides, it is un-counted and pushed again so the correction
 * reaches its ancestors too.
 *
 * `limit` caps the one-sided commits found; `truncated` says it was hit.
 */
export async function partitionReachable({ dir, cache, left, right, limit = 10000 }) {
  const flags = new Map(); // oid → LEFT | RIGHT | BOTH
  const popped = new Set();
  const order = [];        // popped commits, newest first
  const heap = new CommitHeap();
  let pendingSingles = 0;  // queued commits not yet known to be reachable from both
  let pendingFixes = 0;    // popped commits re-queued to propagate BOTH
  let singles = 0;         // popped commits currently counted on one side

  const enqueue = async (oid, side) => {
    const prev = flags.get(oid);
    if (prev === undefined) {
      const c = await git.readCommit({ fs, dir, oid, cache });
      flags.set(oid, side);
      heap.push({ ts: c.commit.committer.timestamp, c });
      if (side !== BOTH) pendingSingles++;
      return;
    }
    const next = prev | side;
    if (next === prev) return;
    flags.set(oid, next); // next is BOTH: prev was one side, side the other (or BOTH)
    if (!popped.has(oid)) { pendingSingles--; return; }
    // Popped too early and counted on one side: un-count, re-propagate.
    singles--;
    const c = await git.readCommit({ fs, dir, oid, cache });
    heap.push({ ts: c.commit.committer.timestamp, c, fix: true });
    pendingFixes++;
  };

  await enqueue(left, LEFT);
  await enqueue(right, RIGHT);

  let truncated = false;
  while (heap.size && (pendingSingles > 0 || pendingFixes > 0)) {
    const { c, fix } = heap.pop();
    const side = flags.get(c.oid);
    if (fix) {
      pendingFixes--;
    } else {
      popped.add(c.oid);
      order.push(c);
      if (side !== BOTH) {
        pendingSingles--;
        if (++singles >= limit) { truncated = true; break; }
      }
    }
    for (const p of c.commit.parent) await enqueue(p, side);
  }
  return {
    left: order.filter((c) => flags.get(c.oid) === LEFT),
    right: order.filter((c) => flags.get(c.oid) === RIGHT),
    truncated,
  };
}

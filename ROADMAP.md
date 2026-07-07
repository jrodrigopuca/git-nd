# 🗺️ git-nd Roadmap

Goal: be a legitimate alternative to Sourcetree/GitKraken — not by cloning them,
but by leaning into what a web-native Git client does better: runs anywhere
(Linux, remote servers, containers), hackable in JavaScript, and first-class
provider integration (PRs/issues) behind a provider-agnostic API.

Effort: **S** = hours · **M** = 1–3 days · **L** = 1–2 weeks.
Status: `[ ]` pending · `[x]` done.

## Recommended order

1. ~~CSRF / localhost hardening~~ ✅ (T1.1)
2. Hunk & line staging (T1.2)
3. File watcher auto-refresh (T1.4)
4. Hybrid native-git backend → SSH + performance (T1.3)
5. Missing history operations: revert, amend, cherry-pick, tags (T1.5)
6. Desktop packaging with Tauri (T3.1)

---

## Tier 1 — Deal-breakers

Without these, power users cannot switch from Sourcetree.

### T1.1 `[x]` CSRF & localhost hardening — **S** *(shipped)*

**Problem**: any web page you visit can `fetch('http://localhost:3847/api/…', {method:'POST'})`.
The API has no per-request auth (tokens are server-global), so a malicious page
could push, delete branches, or read the repo. DNS-rebinding gives the same
access via a hostile hostname.

**Fix**: middleware that (a) rejects requests whose `Host` is not
`localhost:PORT`/`127.0.0.1:PORT` (DNS rebinding), and (b) rejects requests
carrying a cross-site `Origin` header (CSRF). WebSocket upgrades validate
`Origin` the same way. Non-browser clients (curl, scripts) send no `Origin`
and keep working.

### T1.2 `[ ]` Hunk & line-level staging — **M**

**Problem**: staging is whole-file only. Atomic commits require picking
*these 3 lines yes, those 2 no* — Sourcetree's killer feature.

**Sketch**: the diff endpoint already computes aligned rows; group them into
hunks server-side (`diff.structuredPatch`), render each hunk with a
"Stage hunk" button (and per-line checkboxes later). To apply: read HEAD blob,
apply selected hunk(s) to the *index copy* only — write the patched content to
the index with `git.updateIndex`/manual blob write, leaving the workdir
untouched. Inverse operation for unstage.

### T1.3 `[ ]` Hybrid native-git backend (SSH + performance) — **L**

**Problem**: isomorphic-git speaks HTTPS only (no SSH remotes) and
`statusMatrix` crawls on 50k-file repos. Sourcetree delegates to git/libgit2.

**Sketch**: a `backend` abstraction with two implementations:
`isogit` (current, zero-dependency fallback) and `native` (shells out to the
system `git` binary when detected — `git status --porcelain=v2`,
`git fetch/push` inherit the user's SSH agent and credential helpers).
Feature-detect at startup; per-operation routing (network + status via native,
everything else stays isogit until migrated). This unlocks SSH for free.

### T1.4 `[ ]` File-watcher auto-refresh — **S/M**

**Problem**: edit a file in VS Code and git-nd doesn't notice until you act.
The app should feel alive like Sourcetree.

**Sketch**: `chokidar` watching the open repo (ignore `.git/objects`,
`node_modules`), debounce 300ms, broadcast `fs-changed` over the existing
WebSocket; the frontend already has `refreshAll()`. Watch `.git/HEAD` and
`.git/refs/**` too, so external `git checkout` is reflected.

### T1.5 `[ ]` Missing history operations — **M**

- **Revert (safe)**: create the inverse commit of a given commit
  (compute reverse diff, apply, commit "Revert …"). Today only hard reset
  exists, which is destructive — indefensible as the only option.
- **Amend**: `git.commit({ amend: true })` equivalent — replace tip keeping
  parents; UI checkbox "Amend last commit" in the commit box.
- **Cherry-pick**: replay a single commit onto HEAD (the rebase engine's
  replay step already does 90% of this).
- **Tags**: list/create/delete/push (`git.tag`, `git.listTags`); show as chips
  in the graph next to branch labels.
- **Interactive rebase** (squash/reorder/drop): build on the replay engine;
  UI = drag-to-reorder commit list. Largest piece; can ship last.

## Tier 2 — Quality of life

### T2.1 `[ ]` Search — **M**
Commits by message/author/SHA (walk `git.log`, client-side index for recents);
`Ctrl+P` already covers files. Single search box with `@author` / `#sha` filters.

### T2.2 `[ ]` File history & blame — **M**
Per-file log (walk commits filtering by path with tree-entry comparison — the
`changedFiles` helper already does the diff); blame via sequential walk.
Entry point: right-click a file in the tree → "History".

### T2.3 `[ ]` Diff polish — **M**
Word-level highlighting inside changed lines (`diff.diffWords` on paired rows);
syntax highlighting with a lightweight highlighter (e.g. `highlight.js` core,
lazy-loaded) in file viewer and diffs.

### T2.4 `[ ]` Graph virtualization & pagination — **M**
Currently capped at 100 commits. Windowed rendering (render rows in viewport
±50) + "load more" walking older history. Lane algorithm already streams.

### T2.5 `[ ]` Multi-repo awareness — **M**
Explorer already lists recents; add per-repo dirty/ahead/behind badges
(cheap `statusMatrix` on demand) and repo tabs in the topbar. Server needs a
repo-registry instead of the single `repoState` (also fixes two-tabs
interference, see T3.2).

### T2.6 `[ ]` Stash v2 — **S**
Named stash messages, per-stash file preview (stash commits are readable via
`git.readCommit`), drop individual stashes.

### T2.7 `[ ]` Multiple remotes & remote management — **S/M**
Stop hardcoding `origin`: remote picker on push/pull/fetch, add/remove/rename
remotes UI. Backend already takes `remote` params in most functions.

### T2.8 `[ ]` git-flow helpers — **S**
Start/finish feature/release/hotfix as thin macros over existing branch+merge
operations. Pure UI sugar, cheap to add after tags exist.

## Tier 3 — From project to product

### T3.1 `[ ]` Desktop packaging — **M**
Tauri wrapper (≈10 MB, not Electron's 200 MB): tray icon, auto-start server on
a random port, native window. Alternative minimum: `npx git-nd` launcher that
opens the browser.

### T3.2 `[ ]` Multi-session safety — **M**
`repoState` is one global: two tabs on different repos interfere. Options:
repo-registry keyed by id (client sends `repoId` per request) — pairs with
T2.5; WebSocket events scoped per repo.

### T3.3 `[ ]` Submodules & Git LFS — **L**
isomorphic-git support is partial; realistically arrives with the native
backend (T1.3). Document as known limitation until then.

### T3.4 `[ ]` Reflog / undo — **M**
Local operation journal (we already broadcast every mutation) + "Undo last
operation" for branch moves, resets, merges. Sourcetree doesn't have this —
differentiator.

### T3.5 `[ ]` i18n — **S**
UI is English; extract strings to a dictionary, ship es-AR first.

---

## Non-goals (for now)

- Cloning Sourcetree's UI 1:1 — web-native UX wins where it can.
- Windows-specific integrations (TortoiseGit interop, etc.).
- Hosting mode with multi-user auth — this is a local, single-user tool;
  T1.1's threat model depends on it.

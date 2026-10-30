// Visual review (proposal A): every text/background pair meets WCAG AA in
// BOTH themes — 4.5:1 for text, 3:1 for UI component borders — computed from
// the tokens in public/css/style.css itself, so a future color change that
// breaks contrast fails here. Also checks the selectors actually use the
// text-safe tokens.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Comments stripped, like the browser does ("--bg:" inside a comment is not a declaration).
const css = fs.readFileSync(new URL('../public/css/style.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

function themeTokens(theme) {
  const block = css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`))?.[1];
  assert.ok(block, `no ${theme} theme block`);
  const vars = {};
  for (const [, name, value] of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[name] = value.trim();
  // Resolve var(--x) references (one level is enough for these tokens) and
  // expand #rgb to #rrggbb.
  for (const [k, v] of Object.entries(vars)) {
    const ref = v.match(/^var\(--([\w-]+)\)$/);
    if (ref) vars[k] = vars[ref[1]];
  }
  for (const [k, v] of Object.entries(vars)) {
    if (/^#[0-9a-f]{3}$/i.test(v)) vars[k] = `#${[...v.slice(1)].map((ch) => ch + ch).join('')}`;
  }
  return vars;
}

const lum = (hex) => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
/** What `filter: brightness(k)` does to a solid color. */
const brightness = (hex, k) => `#${[1, 3, 5].map((i) => Math.min(255, Math.round(parseInt(hex.slice(i, i + 2), 16) * k)).toString(16).padStart(2, '0')).join('')}`;

for (const theme of ['dark', 'light']) {
  const t = themeTokens(theme);
  const check = (label, fg, bg, min) => {
    assert.match(fg ?? '', /^#[0-9a-f]{6}$/i, `${theme}: ${label}: foreground token missing`);
    assert.match(bg ?? '', /^#[0-9a-f]{6}$/i, `${theme}: ${label}: background token missing`);
    const r = ratio(fg, bg);
    assert.ok(r >= min, `${theme}: ${label} is ${r.toFixed(2)}:1 (needs ${min}:1)`);
  };

  test(`${theme}: solid buttons keep 4.5:1 at rest and on hover`, () => {
    check('primary button', t['accent-fg'], t['accent-solid'], 4.5);
    check('primary button (hover)', t['accent-fg'], brightness(t['accent-solid'], 0.9), 4.5);
    check('danger button', '#ffffff', t['danger-solid'], 4.5);
    check('danger button (hover)', '#ffffff', brightness(t['danger-solid'], 0.9), 4.5);
  });

  test(`${theme}: text tokens are readable on the panel backgrounds`, () => {
    for (const bg of ['bg', 'bg2']) {
      for (const fg of ['fg', 'muted', 'red-text', 'green-text', 'yellow-text', 'link']) {
        check(`${fg} on ${bg}`, t[fg], t[bg], 4.5);
      }
    }
  });

  test(`${theme}: conflict pane labels and branch chips are readable`, () => {
    check('ours label on its pane', t['ours-text'], t['diff-add'], 4.5);
    check('theirs label on its pane', t['theirs-text'], t.incoming, 4.5);
  });

  test(`${theme}: input borders reach 3:1 (UI components)`, () => {
    check('input border on bg', t['border-strong'], t.bg, 3);
    check('input border on bg2', t['border-strong'], t.bg2, 3);
  });
}

test('no text color uses a FILL token anywhere (the whole class, not a list of selectors)', () => {
  // --red/--green/--yellow/--accent/--*-strong are for fills, dots, borders and
  // graph lanes; text must use the *-text / --link tokens checked above.
  const offenders = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)]
    .filter(([, , body]) => /(^|[;\s])color:\s*var\(--(red|green|yellow|accent|ours-strong|incoming-strong)\)/.test(body))
    .map(([, sel]) => sel.trim());
  assert.deepEqual(offenders, []);
  const js = ['app.js', 'graph.js', 'tree.js', 'conflict.js']
    .map((f) => fs.readFileSync(new URL(`../public/js/${f}`, import.meta.url), 'utf8')).join('\n');
  assert.doesNotMatch(js, /color:\s*var\(--(red|green|yellow|accent|ours-strong|incoming-strong)\)/, 'inline text colors too');
  assert.doesNotMatch(js, /t\.current \? 'var\(--accent\)'/, 'the filled current-branch chip uses --accent-solid');
});

test('selectors use the text-safe tokens (not the fill colors)', () => {
  const rule = (sel) => css.match(new RegExp(`(^|\\n)\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`))?.[2] ?? '';
  assert.match(rule('.btn-primary'), /background:\s*var\(--accent-solid\)/);
  assert.match(rule('.btn-danger'), /background:\s*var\(--danger-solid\)/);
  assert.match(css, /\.btn-primary:hover[^{]*\{[^}]*brightness\(0\.9\)/, 'solid buttons darken on hover');
  assert.match(rule('.st-modified'), /var\(--yellow-text\)/);
  assert.match(rule('.st-untracked'), /var\(--green-text\)/);
  assert.match(rule('.st-deleted'), /var\(--red-text\)/);
  assert.match(rule('.cf-pane-head.ours'), /color:\s*var\(--ours-text\)/);
  assert.match(rule('.cf-pane-head.theirs'), /color:\s*var\(--theirs-text\)/);
  assert.match(css, /input\[type="text"\], textarea, select\s*\{[^}]*border:\s*1px solid var\(--border-strong\)/);
  assert.match(css, /(^|\n)a\s*\{[^}]*color:\s*var\(--link\)/, 'links use --link');
});

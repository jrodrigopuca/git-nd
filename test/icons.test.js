// Visual review 2 (R2-3/R2-5): icons are SVG symbols in one local sprite
// (public/icons/sprite.svg) used with <use href="/icons/sprite.svg#i-name">.
// These check the sprite is self-contained, every icon the UI asks for exists,
// the licenses ship with it, and the brand/favicon are the single leaf.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const pub = (p) => new URL(`../public/${p}`, import.meta.url);
const sprite = fs.existsSync(pub('icons/sprite.svg')) ? fs.readFileSync(pub('icons/sprite.svg'), 'utf8') : '';
const symbols = new Set([...sprite.matchAll(/<symbol id="(i-[\w-]+)"/g)].map((m) => m[1]));
const sources = () => ['index.html', ...fs.readdirSync(pub('js')).map((f) => `js/${f}`)]
  .map((f) => fs.readFileSync(pub(f), 'utf8')).join('\n');

test('the sprite exists, and its symbols work through an external <use>', () => {
  assert.ok(symbols.size > 0, 'public/icons/sprite.svg with <symbol id="i-…"> entries');
  // An external <use> cannot resolve ids, masks or gradients that live inside it.
  assert.doesNotMatch(sprite, /<(mask|clipPath|linearGradient|radialGradient|filter)\b/);
  assert.doesNotMatch(sprite.replace(/<symbol id="i-[\w-]+"/g, ''), /\sid="/, 'no ids other than the symbols');
  assert.doesNotMatch(sprite, /url\(#/);
  // Color comes from CSS: no hardcoded fills/strokes.
  assert.doesNotMatch(sprite, /(fill|stroke)="#/);
});

test('every icon the UI references exists in the sprite', () => {
  const src = sources();
  const used = new Set([
    ...[...src.matchAll(/sprite\.svg#(i-[\w-]+)/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bicon\(\s*'([\w-]+)'/g)].map((m) => `i-${m[1]}`),
  ]);
  const missing = [...used].filter((id) => !symbols.has(id));
  assert.deepEqual(missing, []);
});

test('no emoji and no text-glyph icons left in the UI (the whole class, every file)', () => {
  // Comments may use arrows and examples; code and markup may not.
  const code = sources().replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
  const emoji = [...new Set(code.match(/\p{Extended_Pictographic}/gu) || [])];
  assert.deepEqual(emoji, [], 'emojis render per-OS, in fixed colors that fight the status colors');
  // Symbols that played the same role as the emojis. Prose arrows (→ ←) stay.
  const glyphs = [...new Set(code.match(/[⎇⇣⇡⇲⇱▾▶▼✎✕＋⇄✓↻]/gu) || [])];
  assert.deepEqual(glyphs, [], 'icon-like text glyphs');
});

test('the vendored icons ship with their licenses', () => {
  const lic = fs.readFileSync(pub('icons/LICENSE'), 'utf8');
  assert.match(lic, /Lucide/);
  assert.match(lic, /ISC License/);
  assert.match(lic, /Permission to use, copy, modify, and\/or distribute/);
  assert.match(lic, /Simple Icons/);
  assert.match(lic, /CC0/);
});

test('brand (P3): a line leaf in the Lucide grammar, rooted in a commit node filled with --brand', () => {
  const leaf = sprite.match(/<symbol id="i-leaf-brand"[^>]*>([\s\S]*?)<\/symbol>/)?.[1] ?? '';
  // The leaf speaks the same language as every other icon: stroke 2, round
  // caps/joins, in the text color — not a solid blot (the v3 leaf stood out).
  assert.match(leaf, /<g fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">/);
  assert.doesNotMatch(leaf, /fill-rule="evenodd"/);
  // The one accent: the commit node, a filled dot in --brand (graph nodes are dots).
  // As CSS (style=), not a presentation attribute: var() there is not portable.
  assert.match(leaf, /<circle [^>]*style="fill:\s*var\(--brand, currentColor\)"/);

  const html = fs.readFileSync(pub('index.html'), 'utf8');
  assert.match(html, /<link rel="icon" href="\/icons\/favicon\.svg" type="image\/svg\+xml"/);
});

test('favicon (F1): a solid neutral leaf + the teal node, following the theme, with a fallback that works on any tab', () => {
  const fav = fs.readFileSync(pub('icons/favicon.svg'), 'utf8');
  assert.match(fav, /viewBox="0 0 16 16"/, 'drawn on its own 16px grid');
  assert.doesNotMatch(fav, /\p{Extended_Pictographic}/u);
  // Solid leaf (a 1.5px line falls apart at a real 16px raster) and the node.
  assert.match(fav, /<path class="lf"/);
  assert.match(fav, /<circle [^>]*class="d"/);

  const style = fav.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  const colorsIn = (block) => ({
    leaf: block.match(/\.lf\{fill:(#[0-9a-f]{6})\}/i)?.[1],
    node: block.match(/\.d\{fill:(#[0-9a-f]{6})\}/i)?.[1],
  });
  const media = (scheme) => style.match(new RegExp(`@media \\(prefers-color-scheme:${scheme}\\)\\{(.*?\\})\\}`))?.[1] ?? '';
  const fallback = colorsIn(style.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, ''));

  // In each theme it is the app's own mark: leaf = --fg, node = --brand.
  const css = fs.readFileSync(pub('css/style.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const token = (theme, name) => css.match(new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{[^}]*--${name}:\\s*(#[0-9a-f]{6})`, 'i'))?.[1]?.toLowerCase();
  for (const theme of ['light', 'dark']) {
    const c = colorsIn(media(theme));
    assert.equal(c.leaf?.toLowerCase(), token(theme, 'fg'), `${theme}: leaf is --fg`);
    assert.equal(c.node?.toLowerCase(), token(theme, 'brand'), `${theme}: node is --brand`);
  }

  // Without the media query (or with a Chrome theme that disagrees with the
  // system), the fallback must still read on every usual tab color (3:1).
  const lum = (hex) => {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const tab of ['#ffffff', '#dee1e6', '#35363a', '#202124']) {
    for (const part of ['leaf', 'node']) {
      assert.ok(fallback[part], `fallback ${part} color`);
      const r = ratio(fallback[part], tab);
      assert.ok(r >= 3, `fallback ${part} ${fallback[part]} on tab ${tab} is ${r.toFixed(2)}:1`);
    }
  }
});

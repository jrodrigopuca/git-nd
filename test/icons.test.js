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

test('the vendored icons ship with their licenses', () => {
  const lic = fs.readFileSync(pub('icons/LICENSE'), 'utf8');
  assert.match(lic, /Lucide/);
  assert.match(lic, /ISC License/);
  assert.match(lic, /Permission to use, copy, modify, and\/or distribute/);
  assert.match(lic, /Simple Icons/);
  assert.match(lic, /CC0/);
});

test('brand: one leaf with the commit node cut out (evenodd), and an SVG favicon', () => {
  const leaf = sprite.match(/<symbol id="i-leaf-brand"[^>]*>([\s\S]*?)<\/symbol>/)?.[1] ?? '';
  assert.equal((leaf.match(/<path/g) || []).length, 1, 'a single path');
  assert.match(leaf, /fill-rule="evenodd"/);
  assert.match(leaf, /fill="currentColor"/);

  const html = fs.readFileSync(pub('index.html'), 'utf8');
  assert.match(html, /<link rel="icon" href="\/icons\/favicon\.svg" type="image\/svg\+xml"/);
  const fav = fs.readFileSync(pub('icons/favicon.svg'), 'utf8');
  assert.match(fav, /viewBox="0 0 16 16"/, 'drawn on its own 16px grid');
  assert.match(fav, /fill-rule="evenodd"/);
  assert.doesNotMatch(fav, /\p{Extended_Pictographic}/u);
});

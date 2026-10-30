// BACKLOG B-12: no GET has side effects, cross-site requests are refused, and
// /api/* requires the X-GitND header (which a web page cannot send to another
// origin without a CORS preflight the server never grants).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git, makeRepo, cleanup } from './helpers.js';

const PORT = 39000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnd-http-'));
let server;
let remoteHits = 0;
let remote;

before(async () => {
  server = spawn(process.execPath, ['server/index.js'], {
    env: { ...process.env, PORT: String(PORT), HOME: home }, stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${BASE}/`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('server did not start');
});

after(() => {
  server?.kill();
  remote?.close();
  fs.rmSync(home, { recursive: true, force: true });
  cleanup();
});

const ui = { 'X-GitND': '1' };
const call = (p, { method = 'GET', headers = {}, body } = {}) => fetch(`${BASE}${p}`, {
  method,
  headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
  body: body ? JSON.stringify(body) : undefined,
});

test('/api/* without the X-GitND header is refused', async () => {
  assert.equal((await call('/api/repo/info')).status, 403);
  assert.equal((await call('/api/repo/open', { method: 'POST', body: { dir: home } })).status, 403);
});

test('the header check cannot be dodged with case or encoding (Express routes /API/ too)', async () => {
  for (const p of ['/API/auth/status', '/Api/auth/status', '/%61pi/auth/status', '/%41PI/auth/status']) {
    const r = await call(p);
    assert.notEqual(r.status, 200, `${p} answered without the header`);
  }
  const post = await call('/API/repo/open', { method: 'POST', body: { dir: home } });
  assert.equal(post.status, 403, 'POST /API/... without the header');
});

test('with the header, the API answers', async () => {
  const r = await call('/api/auth/status', { headers: ui });
  assert.equal(r.status, 200);
});

test('Sec-Fetch-Site: cross-site / same-site is refused even with the header', async () => {
  for (const site of ['cross-site', 'same-site']) {
    const r = await call('/api/auth/status', { headers: { ...ui, 'Sec-Fetch-Site': site } });
    assert.equal(r.status, 403, site);
  }
  const ok = await call('/api/auth/status', { headers: { ...ui, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(ok.status, 200);
});

test('the page itself and the OAuth routes do not need the header (they are navigations)', async () => {
  assert.equal((await call('/')).status, 200);
  assert.notEqual((await call('/auth/github/login')).status, 403);
});

/** Try a WebSocket handshake: 'open' if it completed, else the HTTP status it got. */
async function wsHandshake(headers) {
  const { WebSocket } = await import('ws');
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers });
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('unexpected-response', (_req, res) => resolve(res.statusCode));
    ws.on('error', () => resolve('error'));
  });
}

test('BACKLOG B-16: a WebSocket from another origin is refused BEFORE the handshake', async () => {
  assert.equal(await wsHandshake({ Origin: 'https://evil.example' }), 403);
  assert.equal(await wsHandshake({ Origin: 'null' }), 403);
  assert.equal(await wsHandshake({ Host: `evil.example:${PORT}`, Origin: `http://evil.example:${PORT}` }), 403);
  assert.equal(await wsHandshake({ Origin: `http://localhost:${PORT}` }), 'open', 'the UI origin still connects');
});

test('GET /api/repo/sync never fetches; the fetch is a POST', async () => {
  remote = http.createServer((req, res) => { remoteHits++; res.writeHead(404); res.end(); });
  await new Promise((r) => remote.listen(0, '127.0.0.1', r));
  const dir = makeRepo('sync');
  git(dir, 'remote', 'add', 'origin', `http://127.0.0.1:${remote.address().port}/x.git`);
  assert.equal((await call('/api/repo/open', { method: 'POST', headers: ui, body: { dir } })).status, 200);

  await call('/api/repo/sync?fetch=1', { headers: ui });
  assert.equal(remoteHits, 0, 'a GET must not reach the network');

  await call('/api/repo/sync/fetch', { method: 'POST', headers: ui });
  assert.ok(remoteHits > 0, 'POST /api/repo/sync/fetch does fetch');
});

// BACKLOG B-01 (reopened): the repo config can send a request somewhere other
// than remote.origin.url — `pushurl`, `http.corsProxy`. The token must follow
// the URL actually requested, and the repo's corsProxy must never be used.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { svc, git, makeRepo, author, cleanup } from './helpers.js';

after(cleanup);

/** A git server that answers 401 and records what it was sent. */
async function attacker() {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || null });
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { seen, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

const tokens = { github: 'ghp_TEST', gitlab: 'glpat_TEST' };

test('pushurl pointing elsewhere: the push request gets no token', async () => {
  const evil = await attacker();
  try {
    const dir = makeRepo('pushurl');
    git(dir, 'remote', 'add', 'origin', 'https://github.com/victim/repo.git'); // looks legit
    git(dir, 'config', 'remote.origin.pushurl', `${evil.url}/stolen.git`);   // where push really goes
    await svc.openRepo(dir);
    await assert.rejects(svc.push({ tokens, author }));
    assert.ok(evil.seen.length >= 1, 'the push went to the pushurl');
    assert.deepEqual(evil.seen.filter((r) => r.auth), [], 'no Authorization header');
  } finally { evil.close(); }
});

test("the repo's http.corsProxy is ignored (fetch and push never go through it)", async () => {
  const evil = await attacker();
  const dead = await attacker(); // stands in for the real remote; no token is ever due here (http)
  try {
    const dir = makeRepo('corsproxy');
    git(dir, 'remote', 'add', 'origin', `${dead.url}/repo.git`);
    git(dir, 'config', 'http.corsProxy', evil.url);
    await svc.openRepo(dir);
    await svc.syncStatus({ tokens, doFetch: true }).catch(() => {});
    await svc.push({ tokens, author }).catch(() => {});
    assert.equal(evil.seen.length, 0, `proxy contacted: ${JSON.stringify(evil.seen)}`);
    assert.ok(dead.seen.length >= 1, 'requests went straight to the remote');
  } finally { evil.close(); dead.close(); }
});

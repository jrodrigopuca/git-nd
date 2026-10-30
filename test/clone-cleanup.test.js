// BACKLOG B-17: a failed clone removes what the clone created — and never a
// folder that already existed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { svc, cleanup } from './helpers.js';

after(cleanup);

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnd-clone-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));

/** A git "server" that refuses everything, so every clone fails. */
async function refusing() {
  const server = http.createServer((req, res) => { res.writeHead(401, { 'WWW-Authenticate': 'Basic' }); res.end(); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/repo.git`, close: () => server.close() };
}

test('failed clone into a new folder (with new parents): nothing is left behind', async () => {
  const srv = await refusing();
  try {
    const target = path.join(base, 'new-parent', 'deeper', 'repo');
    await assert.rejects(svc.cloneRepo(srv.url, target, {}));
    assert.ok(!fs.existsSync(path.join(base, 'new-parent')), 'created parents removed too');
    assert.ok(fs.existsSync(base), 'the pre-existing base folder stays');
  } finally { srv.close(); }
});

test('failed clone into an existing EMPTY folder: the folder stays, and stays empty', async () => {
  const srv = await refusing();
  try {
    const target = path.join(base, 'existing-empty');
    fs.mkdirSync(target);
    await assert.rejects(svc.cloneRepo(srv.url, target, {}));
    assert.ok(fs.existsSync(target), 'pre-existing folder not deleted');
    assert.deepEqual(fs.readdirSync(target), [], 'nothing the clone wrote remains');
  } finally { srv.close(); }
});

test('a non-empty target is refused before anything is touched (regression)', async () => {
  const target = path.join(base, 'not-empty');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep.txt'), 'mine\n');
  await assert.rejects(svc.cloneRepo('http://127.0.0.1:9/x.git', target, {}), /not empty/i);
  assert.equal(fs.readFileSync(path.join(target, 'keep.txt'), 'utf8'), 'mine\n');
});

// BACKLOG B-01: tokens only go to their provider's exact host, over https.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import git from 'isomorphic-git';
import gitHttp from 'isomorphic-git/http/node';
import { credentialsFor, authFor } from '../server/credentials.js';

const tokens = { github: 'ghp_TEST', gitlab: 'glpat_TEST' };
const gh = { username: 'ghp_TEST', password: 'x-oauth-basic' };
const gl = { username: 'oauth2', password: 'glpat_TEST' };

test('GitHub token only for https://github.com', () => {
  assert.deepEqual(credentialsFor('https://github.com/user/repo.git', tokens), gh);
  assert.deepEqual(credentialsFor('https://user@github.com/user/repo.git', tokens), gh);
  assert.equal(credentialsFor('http://github.com/user/repo.git', tokens), null, 'plain http');
  assert.equal(credentialsFor('https://github.com.evil.com/x.git', tokens), null, 'suffix trick');
  assert.equal(credentialsFor('https://evil.com/github.com/x.git', tokens), null, 'host in path');
  assert.equal(credentialsFor('https://notgithub.com/x.git', tokens), null);
  assert.equal(credentialsFor('https://github.com:8443/x.git', tokens), null, 'other port');
  assert.equal(credentialsFor('https://evil.com/x.git', tokens), null);
});

test('GitLab token only for the GITLAB_URL host', () => {
  assert.deepEqual(credentialsFor('https://gitlab.com/group/repo.git', tokens), gl);
  assert.equal(credentialsFor('https://gitlab.evil.com/x.git', tokens), null, 'contains "gitlab"');
  assert.equal(credentialsFor('https://evil.com/gitlab/x.git', tokens), null);
  assert.equal(credentialsFor('http://gitlab.com/group/repo.git', tokens), null, 'plain http');
});

test('self-hosted GitLab configured over http gets its token, nothing else', () => {
  const prev = process.env.GITLAB_URL;
  process.env.GITLAB_URL = 'http://git.internal:8080';
  try {
    assert.deepEqual(credentialsFor('http://git.internal:8080/team/repo.git', tokens), gl);
    assert.deepEqual(credentialsFor('https://git.internal:8080/team/repo.git', tokens), gl);
    assert.equal(credentialsFor('http://git.internal/team/repo.git', tokens), null, 'other port');
    assert.equal(credentialsFor('https://gitlab.com/x.git', tokens), null, 'default host no longer configured');
    assert.equal(credentialsFor('http://evil.com/x.git', tokens), null);
  } finally {
    if (prev === undefined) delete process.env.GITLAB_URL; else process.env.GITLAB_URL = prev;
  }
});

test('no tokens stored → nothing to send; ssh urls → nothing', () => {
  assert.equal(credentialsFor('https://github.com/u/r.git', {}), null);
  assert.equal(credentialsFor('git@github.com:u/r.git', tokens), null);
  assert.deepEqual(authFor(tokens)('https://evil.com/x.git'), { cancel: true });
  assert.deepEqual(authFor(tokens)('https://github.com/u/r.git'), gh, 'decided by the URL passed to onAuth');
});

test('a git server answering 401 never receives a token (the attack from B-01)', async () => {
  const seen = [];
  const server = http.createServer((req, res) => {
    seen.push(req.headers.authorization || null);
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/victim.git`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnd-b01-'));
  try {
    await assert.rejects(git.clone({ fs, http: gitHttp, dir, url, onAuth: authFor(tokens) }));
    assert.ok(seen.length >= 1, 'the server was contacted');
    assert.deepEqual(seen.filter(Boolean), [], 'no Authorization header was sent');
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

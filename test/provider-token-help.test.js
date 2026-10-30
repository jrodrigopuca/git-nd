// R2-6: the Connections card tells you which scopes a token needs and where to
// create one. Those come from the provider itself — the same scopes OAuth asks
// for — so the help can't drift from what the app really requests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getProvider, listProviders } from '../server/providers/index.js';

test('every provider describes its token: the scopes OAuth uses, and a creation URL', () => {
  for (const name of listProviders()) {
    const p = getProvider(name);
    assert.ok(Array.isArray(p.token?.scopes) && p.token.scopes.length, `${name}: token.scopes`);
    const authorize = new URL(p.oauth.authorizeUrl('id', 'http://localhost/cb', 'st'));
    assert.equal(authorize.searchParams.get('scope'), p.token.scopes.join(' '), `${name}: OAuth asks for the same scopes`);
    const create = new URL(p.token.createUrl);
    assert.equal(create.protocol, 'https:');
  }
});

test('the creation links prefill the scopes', () => {
  assert.match(getProvider('github').token.createUrl, /^https:\/\/github\.com\/settings\/tokens\/new\?scopes=repo,read:user&description=git-nd$/);
  const gl = new URL(getProvider('gitlab').token.createUrl);
  assert.equal(gl.searchParams.get('scopes'), 'api,read_user');
  assert.equal(gl.searchParams.get('name'), 'git-nd');
});

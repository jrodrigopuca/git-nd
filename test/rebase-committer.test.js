// BACKLOG B-14: commits replayed by Pull --rebase keep their AUTHOR (name and
// date) but get the current user as COMMITTER with the current time, like
// `git rebase`. Keeping the old committer date put rebased commits "older"
// than their new parent, and the graph orders by committer date.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { svc, git, makeRepo, write, cleanup } from './helpers.js';

after(cleanup);

const OLD = '2020-01-02T03:04:05Z';
const fmt = (dir, f) => git(dir, 'log', '-1', `--format=${f}`, 'HEAD');

test('rebased commit: author and author date kept, committer = current user, now', async () => {
  const dir = makeRepo('rebase-committer', { 'a.txt': 'a\n' });
  // "Remote" moved on: origin/main is a newer commit the local branch lacks.
  git(dir, 'checkout', '-q', '-b', 'upstream');
  write(dir, 'u.txt', 'upstream\n');
  git(dir, 'add', 'u.txt');
  git(dir, 'commit', '-qm', 'upstream work');
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'upstream');
  git(dir, 'checkout', '-q', 'main');
  // A local commit authored (and committed) back in 2020 by someone else.
  write(dir, 'l.txt', 'local\n');
  git(dir, 'add', 'l.txt');
  execFileSync('git', ['commit', '-qm', 'old local work'], {
    cwd: dir,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Old Author', GIT_AUTHOR_EMAIL: 'old@x', GIT_AUTHOR_DATE: OLD,
      GIT_COMMITTER_NAME: 'Old Author', GIT_COMMITTER_EMAIL: 'old@x', GIT_COMMITTER_DATE: OLD },
  });

  await svc.openRepo(dir);
  const me = { name: 'Current User', email: 'me@x' };
  const before = Math.floor(Date.now() / 1000);
  const r = await svc.rebaseOnto('main', 'origin/main', me);
  assert.equal(r.replayed, 1);

  assert.equal(fmt(dir, '%s'), 'old local work');
  assert.equal(fmt(dir, '%an <%ae>'), 'Old Author <old@x>', 'author kept');
  assert.equal(fmt(dir, '%aI'), '2020-01-02T03:04:05Z', 'author date kept');
  assert.equal(fmt(dir, '%cn <%ce>'), 'Current User <me@x>', 'committer = current user');
  assert.ok(Number(fmt(dir, '%ct')) >= before, 'committer date = now');
  assert.ok(Number(fmt(dir, '%ct')) >= Number(git(dir, 'log', '-1', '--format=%ct', 'HEAD~1')), 'not older than its parent');
});

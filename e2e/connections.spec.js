// Visual review 2, R2-6: Connections. One card per provider with its state;
// the token field has a visible label, a show/hide toggle, the scopes it needs
// and where to create it; a rejected token is explained NEXT TO the field (a
// toast alone vanished), and the encryption note is reassurance at the foot.
// /api/auth/* is answered in the browser: no real GitHub/GitLab calls.
import { test, expect } from './fixtures.js';

const status = (providers) => ({ providers });
const github = (over = {}) => ({ name: 'github', connected: false, user: null, oauthConfigured: false, ...over });
const gitlab = (over = {}) => ({ name: 'gitlab', connected: false, user: null, oauthConfigured: false, ...over });

async function openConnections(page, app, repos, providers) {
  let current = providers;
  // The real server answer (it carries each provider's token help), with only
  // the connection state overridden — no copy of server data in the test.
  await page.route('**/api/auth/status', async (r) => {
    const real = await (await r.fetch()).json();
    const merged = current.map((p) => ({ ...real.providers.find((q) => q.name === p.name), ...p }));
    await r.fulfill({ json: status(merged) });
  });
  await app.boot(repos.make('R'));
  await page.locator('.act-btn[data-view="connections"]').click();
  return { set: (p) => { current = p; } };
}

const card = (page, name) => page.locator(`.conn-card[data-provider="${name}"]`);

test('not connected: a labelled token field, the scopes it needs and where to create it', async ({ app, repos, page }) => {
  await openConnections(page, app, repos, [github(), gitlab()]);
  const gh = card(page, 'github');
  await expect(gh.locator('.conn-state')).toHaveText('Not connected');
  const input = gh.getByLabel('Personal access token');
  await expect(input).toHaveAttribute('type', 'password');
  await expect(gh).toContainText('repo');
  await expect(gh).toContainText('read:user');
  const link = gh.getByRole('link', { name: /create a token on github/i });
  await expect(link).toHaveAttribute('href', /github\.com\/settings\/tokens\/new\?scopes=repo,read:user/);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', /noopener/);
  await expect(card(page, 'gitlab')).toContainText('read_user');
  // OAuth setup is not the first thing you read: it is folded away.
  await expect(gh.locator('details')).not.toHaveAttribute('open', '');
  // The encryption note is at the foot, after the cards.
  const order = await page.evaluate(() => {
    const note = document.getElementById('conn-note');
    const cards = document.getElementById('conn-cards');
    return !!(cards.compareDocumentPosition(note) & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  expect(order, 'encryption note after the cards').toBe(true);
});

test('the eye button shows and hides the token, and says which', async ({ app, repos, page }) => {
  await openConnections(page, app, repos, [github(), gitlab()]);
  const gh = card(page, 'github');
  const input = gh.getByLabel('Personal access token');
  const eye = gh.getByRole('button', { name: 'Show token' });
  await expect(eye).toHaveAttribute('aria-pressed', 'false');
  await eye.click();
  await expect(input).toHaveAttribute('type', 'text');
  await expect(eye).toHaveAttribute('aria-pressed', 'true');
  await eye.click();
  await expect(input).toHaveAttribute('type', 'password');
});

test('a rejected token: the error stays next to the field, linked to it', async ({ app, repos, page }) => {
  await openConnections(page, app, repos, [github(), gitlab()]);
  let release;
  const held = new Promise((r) => { release = r; });
  await page.route('**/api/auth/token', async (r) => { await held; await r.fulfill({ status: 401, json: { error: 'Bad credentials' } }); });
  const gh = card(page, 'github');
  const input = gh.getByLabel('Personal access token');
  await input.fill('ghp_wrong');
  await gh.getByRole('button', { name: 'Connect' }).click();
  // While checking: busy, and the controls can't be pressed twice.
  await expect(gh.getByRole('button', { name: /checking/i })).toBeDisabled();
  await expect(input).toBeDisabled();
  release();

  await expect(input).toHaveAttribute('aria-invalid', 'true');
  const errId = await input.getAttribute('aria-describedby');
  expect(errId).toBeTruthy();
  const err = page.locator(`[id="${errId.split(' ').find((id) => id.endsWith('-error'))}"]`);
  await expect(err).toContainText('Bad credentials');
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue('ghp_wrong'); // you fix it, you don't retype it
  await page.waitForTimeout(4000); // longer than a toast lives
  await expect(err).toBeVisible();
  // Typing again clears the error state.
  await input.fill('ghp_other');
  await expect(input).not.toHaveAttribute('aria-invalid', 'true');
});

test('connected: who you are, a way to browse, and Disconnect', async ({ app, repos, page }) => {
  const s = await openConnections(page, app, repos, [github(), gitlab()]);
  await page.route('**/api/auth/token', (r) => r.fulfill({ json: { provider: 'github', user: { login: 'octo', name: 'Octo Cat', email: 'octo@example.invalid' } } }));
  const gh = card(page, 'github');
  s.set([github({ connected: true, user: { login: 'octo', name: 'Octo Cat', email: 'octo@example.invalid' } }), gitlab()]);
  await gh.getByLabel('Personal access token').fill('ghp_ok');
  await gh.getByRole('button', { name: 'Connect' }).click();
  await expect(gh.locator('.conn-state')).toHaveText('Connected');
  await expect(gh).toContainText('Octo Cat');
  await expect(gh).toContainText('@octo');
  await expect(gh.getByRole('button', { name: 'Disconnect' })).toBeVisible();
  await expect(gh.getByRole('button', { name: /browse repositories/i })).toBeVisible();
  await expect(gh.getByLabel('Personal access token')).toHaveCount(0);
});

test('OAuth configured: one-click sign-in is the primary, the token is the folded alternative', async ({ app, repos, page }) => {
  await openConnections(page, app, repos, [github({ oauthConfigured: true }), gitlab()]);
  const gh = card(page, 'github');
  await expect(gh.getByRole('link', { name: 'Sign in with GitHub' })).toHaveClass(/btn-primary/);
  await expect(gh.locator('.btn-primary')).toHaveCount(1);
  await expect(gh.getByLabel('Personal access token')).toBeHidden();
  await gh.locator('summary', { hasText: /personal access token instead/i }).click();
  await expect(gh.getByLabel('Personal access token')).toBeVisible();
});

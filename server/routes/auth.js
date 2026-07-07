import { Router } from 'express';
import crypto from 'node:crypto';
import { getProvider, listProviders } from '../providers/index.js';
import { tokenStore } from '../tokenStore.js';
import { AppError } from '../state.js';

export const authRouter = Router();

const oauthEnv = {
  github: () => process.env.GITHUB_CLIENT_ID,
  gitlab: () => process.env.GITLAB_CLIENT_ID,
};

function redirectUri(req, provider) {
  return `${req.protocol}://${req.get('host')}/auth/${provider}/callback`;
}

/* OAuth flow: /auth/github/login → provider → /auth/github/callback */
authRouter.get('/auth/:provider/login', (req, res, next) => {
  try {
    const { provider } = req.params;
    const clientId = oauthEnv[provider]?.();
    if (!clientId) {
      throw new AppError(
        `OAuth is not configured for ${provider}. Set ${provider.toUpperCase()}_CLIENT_ID and ` +
        `${provider.toUpperCase()}_CLIENT_SECRET, or use a personal access token (PAT).`, 501);
    }
    const state = crypto.randomBytes(16).toString('hex');
    req.session.oauthState = state;
    res.redirect(getProvider(provider).oauth.authorizeUrl(clientId, redirectUri(req, provider), state));
  } catch (err) { next(err); }
});

authRouter.get('/auth/:provider/callback', async (req, res, next) => {
  try {
    const { provider } = req.params;
    const { code, state } = req.query;
    if (!code || state !== req.session.oauthState) {
      throw new AppError('Invalid OAuth callback (state mismatch)', 401);
    }
    delete req.session.oauthState;
    const p = getProvider(provider);
    const token = await p.oauth.exchangeCode(code, redirectUri(req, provider));
    const user = await p.getUser(token);
    tokenStore.set(provider, token, user);
    res.redirect('/');
  } catch (err) { next(err); }
});

/* PAT fallback: paste a personal access token */
authRouter.post('/api/auth/token', async (req, res, next) => {
  try {
    const { provider, token } = req.body;
    if (!provider || !token) throw new AppError('Missing provider or token', 400);
    const user = await getProvider(provider).getUser(token); // validates the token
    tokenStore.set(provider, token, user);
    res.json({ provider, user });
  } catch (err) { next(err); }
});

authRouter.get('/api/auth/status', (req, res) => {
  res.json({
    providers: listProviders().map((name) => ({
      name,
      connected: !!tokenStore.get(name),
      user: tokenStore.user(name),
      oauthConfigured: !!oauthEnv[name]?.(),
    })),
  });
});

authRouter.post('/api/auth/logout', (req, res) => {
  const { provider } = req.body;
  if (provider) tokenStore.remove(provider);
  else tokenStore.clear();
  res.json({ ok: true });
});

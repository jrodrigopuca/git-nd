import express from 'express';
import session from 'express-session';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repoRouter } from './routes/repo.js';
import { authRouter } from './routes/auth.js';
import { providersRouter } from './routes/providers.js';
import { registerSocket } from './state.js';
import { credentialHosts } from './credentials.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3847;

const app = express();

/**
 * Localhost hardening. The API has no per-request auth (tokens live
 * server-side), so the browser's same-origin rules are the security boundary:
 *  - Host allowlist stops DNS-rebinding (evil.com resolving to 127.0.0.1).
 *  - Origin allowlist stops CSRF (a malicious page POSTing to localhost).
 * Non-browser clients (curl, scripts) send no Origin and are unaffected.
 */
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin GETs and non-browser clients
  try {
    return ALLOWED_HOSTS.has(new URL(origin).host);
  } catch {
    return false;
  }
}

app.use((req, res, next) => {
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    return res.status(403).json({ error: 'Forbidden: unexpected Host header' });
  }
  if (!isAllowedOrigin(req.headers.origin)) {
    return res.status(403).json({ error: 'Forbidden: cross-origin requests are not allowed' });
  }
  // Cross-site <img>/<script> GETs carry no Origin, so the check above lets
  // them through (BACKLOG B-12). Browsers that send Sec-Fetch-Site say so
  // explicitly; another localhost port counts as "same-site", also refused.
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') {
    return res.status(403).json({ error: 'Forbidden: cross-site requests are not allowed' });
  }
  // Defense in depth for browsers without Sec-Fetch-*: the API requires a
  // custom header, which another origin cannot send without a CORS preflight
  // this server never grants. The UI always sends it; scripts must add it.
  // (Page loads and the OAuth /auth/* redirects are navigations: not under /api.)
  // Compare the path the way Express ROUTES it: case-insensitive and decoded.
  // A plain startsWith('/api/') let `/API/...` reach the API with no header.
  let routedPath;
  try {
    routedPath = decodeURIComponent(req.path).toLowerCase();
  } catch {
    return res.status(400).json({ error: 'Bad request path' });
  }
  if (routedPath.startsWith('/api') && req.headers['x-gitnd'] !== '1') {
    return res.status(403).json({ error: 'Forbidden: missing X-GitND: 1 header (required for API calls)' });
  }
  next();
});

app.use(express.json({ limit: '10mb' }));

const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: false,
  saveUninitialized: true,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 7 * 24 * 60 * 60 * 1000 },
});
app.use(sessionMiddleware);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use(authRouter);
app.use(repoRouter);
app.use(providersRouter);

/* Friendly errors: message + status, never a stacktrace to the frontend. */
app.use((err, req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  const message = err.status
    ? err.message
    : humanize(err) || 'Internal server error';
  res.status(status).json({ error: message, code: err.code });
});

/** Map common isomorphic-git errors to friendly Spanish messages. */
function humanize(err) {
  const map = {
    HttpError: 'The remote rejected the operation. Is your token valid and does it have the right permissions?',
    UserCanceledError: `Authentication required. Tokens are only sent to ${credentialHosts()}: connect that provider, or use a remote on one of those hosts.`,
    NotFoundError: 'The requested resource was not found in the repository',
    CheckoutConflictError: `Local changes would be overwritten: ${err.data?.filepaths?.join(', ') || ''}`,
    PushRejectedError: 'Push rejected: the remote has commits you do not have. Pull first.',
    MergeNotSupportedError: 'This type of merge is not supported by the engine yet',
    AlreadyExistsError: 'An item with that name already exists',
    AmbiguousError: 'Ambiguous reference: be more specific',
  };
  return map[err.code] || map[err.name] || (err.code ? `Git error (${err.code}): ${err.message}` : null);
}

const server = http.createServer(app);
// Browsers always send Origin on WebSocket upgrades. Checked in verifyClient,
// so a foreign origin gets a 403 and the handshake never completes; closing
// after `connection` (as before) let it open first (BACKLOG B-16).
const wss = new WebSocketServer({
  server,
  path: '/ws',
  verifyClient: ({ req }, done) => {
    const ok = ALLOWED_HOSTS.has(req.headers.host) && isAllowedOrigin(req.headers.origin);
    done(ok, ok ? undefined : 403, ok ? undefined : 'Forbidden origin');
  },
});
wss.on('connection', (ws) => registerSocket(ws));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  git-nd running at http://localhost:${PORT}\n`);
});

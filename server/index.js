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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3847;

const app = express();
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
    UserCanceledError: 'Authentication required: connect GitHub/GitLab or add a token',
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
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', (ws) => registerSocket(ws));

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  git-nd running at http://localhost:${PORT}\n`);
});

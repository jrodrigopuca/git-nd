import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/**
 * Persistent, encrypted token storage (~/.git-nd/tokens.enc).
 *
 * Tokens are encrypted with AES-256-GCM. The key comes from GITND_KEY
 * (hex, optional) or a generated ~/.git-nd/secret.key with 0600 perms.
 * This protects tokens at rest (backups, sync tools, casual reads);
 * an attacker who can read BOTH files as your user can still decrypt —
 * that's the ceiling for any local app without an OS keychain.
 */
const DIR = path.join(os.homedir(), '.git-nd');
const KEY_FILE = path.join(DIR, 'secret.key');
const STORE_FILE = path.join(DIR, 'tokens.enc');

function getKey() {
  if (process.env.GITND_KEY) return Buffer.from(process.env.GITND_KEY, 'hex');
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(KEY_FILE)) {
    fs.writeFileSync(KEY_FILE, crypto.randomBytes(32), { mode: 0o600 });
  }
  return fs.readFileSync(KEY_FILE);
}

function encrypt(plain) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return JSON.stringify({
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

function decrypt(raw) {
  const { iv, tag, data } = JSON.parse(raw);
  const decipher = crypto.createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

function load() {
  try {
    return JSON.parse(decrypt(fs.readFileSync(STORE_FILE, 'utf8')));
  } catch {
    return {}; // first run, or key changed → start clean
  }
}

function persist(entries) {
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(STORE_FILE, encrypt(JSON.stringify(entries)), { mode: 0o600 });
}

let entries = load();

export const tokenStore = {
  get(provider) { return entries[provider]?.token || null; },
  user(provider) { return entries[provider]?.user || null; },
  set(provider, token, user) {
    entries[provider] = { token, user };
    persist(entries);
  },
  remove(provider) {
    delete entries[provider];
    persist(entries);
  },
  clear() {
    entries = {};
    persist(entries);
  },
  /** { github: token, gitlab: token } — shape expected by gitService auth. */
  tokens() {
    return Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, v.token]));
  },
};

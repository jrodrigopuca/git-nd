import { toast } from './ui.js';

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Error ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => request('GET', url),
  post: (url, body = {}) => request('POST', url, body),
};

/** Run an API call with spinner + error toast. Returns null on failure. */
export async function withUi(promise, { loading, success } = {}) {
  const spinner = document.getElementById('spinner');
  const spinnerText = document.getElementById('spinner-text');
  if (loading) {
    spinnerText.textContent = loading;
    spinner.hidden = false;
  }
  try {
    const result = await promise;
    if (success) toast(success, 'success');
    return result;
  } catch (err) {
    toast(err.message, 'error');
    return null;
  } finally {
    spinner.hidden = true;
  }
}

/* ---- WebSocket with auto-reconnect ---- */
const listeners = new Map();

export function onEvent(type, fn) {
  if (!listeners.has(type)) listeners.set(type, []);
  listeners.get(type).push(fn);
}

function connectWs() {
  const ws = new WebSocket(`ws://${location.host}/ws`);
  ws.onmessage = (e) => {
    try {
      const { type, payload } = JSON.parse(e.data);
      (listeners.get(type) || []).forEach((fn) => fn(payload));
      (listeners.get('*') || []).forEach((fn) => fn(type, payload));
    } catch { /* ignore malformed */ }
  };
  ws.onclose = () => setTimeout(connectWs, 2000);
}
connectWs();

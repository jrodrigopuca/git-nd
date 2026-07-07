import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** Plain JSON app settings (~/.git-nd/settings.json). Not for secrets. */
const FILE = path.join(os.homedir(), '.git-nd', 'settings.json');

export function getSettings() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function saveSettings(patch) {
  const merged = { ...getSettings(), ...patch };
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(merged, null, 2));
  return merged;
}

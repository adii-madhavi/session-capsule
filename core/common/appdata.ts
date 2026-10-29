import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { ensureDir } from './fsx.ts';

// Per-user data folder for import journals, backups, temp files and logs.
// SESSION_CAPSULE_HOME overrides it (used by tests).
export function appHome(): string {
  if (process.env.SESSION_CAPSULE_HOME) return process.env.SESSION_CAPSULE_HOME;
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Session Capsule');
  if (process.platform === 'win32') {
    return path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Session Capsule');
  }
  return path.join(process.env.XDG_DATA_HOME ?? path.join(home, '.local', 'share'), 'session-capsule');
}

export function appDir(...parts: string[]): string {
  return ensureDir(path.join(appHome(), ...parts));
}

export function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(appDir('tmp'), `${prefix}-`));
}

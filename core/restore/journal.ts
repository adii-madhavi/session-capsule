// Import journals and backups, kept in the per-user data folder until the user
// removes them (retention is an open product decision, so nothing expires).

import fs from 'node:fs';
import path from 'node:path';
import { appDir, appHome } from '../common/appdata.ts';
import { readJson, writeJsonAtomic } from '../common/fsx.ts';
import { sha256 } from '../common/hash.ts';

export type ImportState = 'prepared' | 'applying' | 'applied' | 'rolling-back' | 'rolled-back';

export type Action =
  | { type: 'write'; path: string; sourcePath: string; writtenSha256: string; executable: boolean; crlf: boolean }
  | { type: 'delete'; path: string; expectSha256: string };

export interface Original {
  path: string;
  existed: boolean;
  sha256: string | null;
}

export interface Journal {
  importId: string;
  capsuleId: string;
  capsuleFile: string;
  dest: string;
  createdAt: string;
  updatedAt: string;
  state: ImportState;
  actions: Action[];
  originals: Original[];
  createdDirs: string[];
  done: number[];
}

export interface ImportSummary {
  importId: string;
  capsuleId: string;
  dest: string;
  state: ImportState;
  createdAt: string;
  actions: number;
}

const ID = /^[0-9a-f-]{36}$/;

export function importDir(importId: string): string {
  if (!ID.test(importId)) throw new Error(`Not an import id: ${JSON.stringify(importId.slice(0, 60))}`);
  return path.join(appHome(), 'imports', importId);
}

export function backupPath(importId: string, rel: string): string {
  return path.join(importDir(importId), 'backup', ...rel.split('/'));
}

export function saveJournal(j: Journal): void {
  j.updatedAt = new Date().toISOString();
  fs.mkdirSync(importDir(j.importId), { recursive: true });
  writeJsonAtomic(path.join(importDir(j.importId), 'journal.json'), j);
}

export function loadJournal(importId: string): Journal {
  const file = path.join(importDir(importId), 'journal.json');
  if (!fs.existsSync(file)) throw new Error(`No import ${importId} was found.`);
  return readJson<Journal>(file);
}

export function listImports(): ImportSummary[] {
  const dir = path.join(appHome(), 'imports');
  if (!fs.existsSync(dir)) return [];
  const out: ImportSummary[] = [];
  for (const id of fs.readdirSync(dir)) {
    if (!ID.test(id)) continue;
    try {
      const j = loadJournal(id);
      out.push({ importId: j.importId, capsuleId: j.capsuleId, dest: j.dest, state: j.state, createdAt: j.createdAt, actions: j.actions.length });
    } catch {
      // unreadable journal: reported by `capsule recover` as damaged
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export const INTERRUPTED: ImportState[] = ['prepared', 'applying', 'rolling-back'];

// One import at a time per destination folder.
export function lockDestination(dest: string): () => void {
  const file = path.join(appDir('locks'), `${sha256(path.resolve(dest).toLowerCase())}.lock`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = pid !== process.pid;
      } catch {
        alive = false;
      }
      if (alive) throw new Error(`Another import into ${dest} is running (process ${pid}).`);
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error(`Could not lock ${dest} for import.`);
}

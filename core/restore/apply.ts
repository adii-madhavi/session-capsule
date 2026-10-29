// Apply, rollback and resume. Order of operations:
//   1. re-check every target against the preview (nothing changed since),
//   2. back up every affected file and record the journal ("prepared"),
//   3. write each file to a temp sibling and rename it into place ("applying"),
//   4. mark the journal "applied".
// An interruption at any point leaves a journal that `rollback` or `resume`
// finishes consistently. Each step checks file hashes, so re-running is safe.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256, toCrlf, eolStyle, isText } from '../common/hash.ts';
import { renameWithRetry, tempSibling, writeAll } from '../common/fsx.ts';
import { DestinationInspector, resolveInside } from '../common/paths.ts';
import { logEvent } from '../common/log.ts';
import type { OpenedCapsule } from '../archive/capsule.ts';
import { inspectDestFile, type ImportPlan, type PlanOp } from './plan.ts';
import { backupPath, importDir, INTERRUPTED, loadJournal, lockDestination, saveJournal, type Action, type Journal } from './journal.ts';

export type Decision = 'incoming' | 'keep' | 'both';

export interface Decisions {
  conflicts?: Record<string, Decision>;
  defaultConflict?: Decision;
  deletions?: 'apply' | 'skip';
  skip?: string[];
}

export class UnresolvedError extends Error {
  paths: string[];
  constructor(message: string, paths: string[]) {
    super(message);
    this.paths = paths;
  }
}

export class SimulatedInterruption extends Error {}

function siblingName(dest: string, rel: string, capsuleId: string): string {
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel);
  const base = path.posix.basename(rel, ext);
  for (let n = 0; ; n++) {
    const name = `${base}.from-capsule-${capsuleId.slice(0, 8)}${n ? `-${n}` : ''}${ext}`;
    const candidate = dir === '.' ? name : `${dir}/${name}`;
    if (!fs.existsSync(resolveInside(dest, candidate))) return candidate;
  }
}

interface Resolved {
  actions: Array<Action & { expect: { exists: boolean; sha256: string | null } }>;
  unresolved: string[];
  blocked: string[];
}

export function resolveActions(c: OpenedCapsule, plan: ImportPlan, d: Decisions): Resolved {
  const skip = new Set(d.skip ?? []);
  const out: Resolved = { actions: [], unresolved: [], blocked: [] };
  const write = (op: Extract<PlanOp, { sha256: string }>, target: string, matchCrlf: boolean, expect: { exists: boolean; sha256: string | null }) => {
    let data = c.readPayload(op.path);
    const crlf = matchCrlf && isText(data) && eolStyle(data) === 'lf';
    if (crlf) data = toCrlf(data);
    out.actions.push({ type: 'write', path: target, sourcePath: op.path, writtenSha256: sha256(data), executable: op.executable, crlf, expect });
  };
  for (const op of plan.ops) {
    if (skip.has(op.path)) continue;
    switch (op.kind) {
      case 'create':
        write(op, op.path, false, { exists: false, sha256: null });
        break;
      case 'update':
        write(op, op.path, op.matchCrlf, { exists: true, sha256: op.destSha256 });
        break;
      case 'conflict': {
        const choice = d.conflicts?.[op.path] ?? d.defaultConflict;
        if (!choice) out.unresolved.push(op.path);
        else if (choice === 'incoming') write(op, op.path, false, { exists: true, sha256: op.destSha256 });
        else if (choice === 'both') write(op, siblingName(plan.dest, op.path, plan.capsuleId), false, { exists: false, sha256: null });
        break;
      }
      case 'delete':
        if (d.deletions === 'apply') out.actions.push({ type: 'delete', path: op.path, expectSha256: op.destSha256, expect: { exists: true, sha256: op.destSha256 } });
        else if (d.deletions !== 'skip') out.unresolved.push(op.path);
        break;
      case 'delete-conflict': {
        const choice = d.conflicts?.[op.path] ?? d.defaultConflict;
        if (!choice) out.unresolved.push(op.path);
        else if (choice === 'incoming') out.actions.push({ type: 'delete', path: op.path, expectSha256: op.destSha256, expect: { exists: true, sha256: op.destSha256 } });
        break;
      }
      case 'blocked':
        out.blocked.push(op.path);
        break;
      default:
        break;
    }
  }
  return out;
}

function writeTarget(dest: string, a: Extract<Action, { type: 'write' }>, data: Buffer, createdDirs: Set<string>): void {
  const abs = resolveInside(dest, a.path);
  const parts = a.path.split('/').slice(0, -1);
  for (let i = 1; i <= parts.length; i++) {
    const dirRel = parts.slice(0, i).join('/');
    const dirAbs = resolveInside(dest, dirRel);
    const st = fs.lstatSync(dirAbs, { throwIfNoEntry: false });
    if (!st) {
      fs.mkdirSync(dirAbs);
      createdDirs.add(dirRel);
    } else if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Refusing to write through ${dirRel}: it is not a plain folder.`);
  }
  const tmp = tempSibling(abs, 'capsule-tmp');
  const fd = fs.openSync(tmp, 'wx', a.executable ? 0o755 : 0o644);
  try {
    writeAll(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  if (a.executable && process.platform !== 'win32') fs.chmodSync(tmp, 0o755);
  renameWithRetry(tmp, abs);
}

function payloadFor(c: OpenedCapsule, a: Extract<Action, { type: 'write' }>): Buffer {
  const data = c.readPayload(a.sourcePath);
  const out = a.crlf ? toCrlf(data) : data;
  if (sha256(out) !== a.writtenSha256) throw new Error(`Capsule contents for ${a.sourcePath} changed unexpectedly.`);
  return out;
}

export interface ApplyResult {
  importId: string;
  written: number;
  deleted: number;
  skipped: string[];
}

export function applyImport(c: OpenedCapsule, plan: ImportPlan, decisions: Decisions, opts: { failAfter?: number } = {}): ApplyResult {
  if (plan.mode !== 'full') throw new Error('A context-only capsule carries no files to apply.');
  const resolved = resolveActions(c, plan, decisions);
  if (resolved.blocked.length) throw new UnresolvedError(`${resolved.blocked.length} files can't be written here safely. Skip them to continue.`, resolved.blocked);
  if (resolved.unresolved.length) throw new UnresolvedError(`${resolved.unresolved.length} conflicts or deletions need a decision before anything is applied.`, resolved.unresolved);

  const unlock = lockDestination(plan.dest);
  try {
    const inspector = new DestinationInspector(plan.dest, plan.platform);
    for (const a of resolved.actions) {
      const blocking = inspector.issuesFor(a.path).filter((i) => i.blocking && i.kind !== 'not-a-file');
      if (blocking.length) throw new Error(`Stopped before writing anything: ${blocking[0].detail}`);
      const now = inspectDestFile(resolveInside(plan.dest, a.path));
      if (now.exists !== a.expect.exists || (a.expect.sha256 && now.sha256 !== a.expect.sha256)) {
        throw new Error(`Stopped before writing anything: ${a.path} changed after the preview. Preview the import again.`);
      }
    }

    const importId = randomUUID();
    const journal: Journal = {
      importId,
      capsuleId: plan.capsuleId,
      capsuleFile: path.resolve(c.file),
      dest: path.resolve(plan.dest),
      createdAt: new Date().toISOString(),
      updatedAt: '',
      state: 'prepared',
      actions: resolved.actions.map(({ expect: _expect, ...a }) => a as Action),
      originals: [],
      createdDirs: [],
      done: [],
    };
    for (const a of journal.actions) {
      const abs = resolveInside(plan.dest, a.path);
      if (fs.existsSync(abs)) {
        const backup = backupPath(importId, a.path);
        fs.mkdirSync(path.dirname(backup), { recursive: true });
        fs.copyFileSync(abs, backup);
        journal.originals.push({ path: a.path, existed: true, sha256: sha256(fs.readFileSync(backup)) });
      } else journal.originals.push({ path: a.path, existed: false, sha256: null });
    }
    saveJournal(journal);
    logEvent('import.prepared', { importId, capsuleId: plan.capsuleId, actions: journal.actions.length });

    journal.state = 'applying';
    saveJournal(journal);
    const createdDirs = new Set<string>();
    journal.actions.forEach((a, i) => {
      if (opts.failAfter !== undefined && i >= opts.failAfter) throw new SimulatedInterruption(`simulated interruption after ${i} actions`);
      if (a.type === 'write') writeTarget(plan.dest, a, payloadFor(c, a), createdDirs);
      else fs.rmSync(resolveInside(plan.dest, a.path), { force: true });
      journal.done.push(i);
      journal.createdDirs = [...createdDirs];
      saveJournal(journal);
    });
    journal.state = 'applied';
    saveJournal(journal);
    logEvent('import.applied', { importId, capsuleId: plan.capsuleId, actions: journal.actions.length });
    return {
      importId,
      written: journal.actions.filter((a) => a.type === 'write').length,
      deleted: journal.actions.filter((a) => a.type === 'delete').length,
      skipped: decisions.skip ?? [],
    };
  } finally {
    unlock();
  }
}

function currentSha(dest: string, rel: string): string | null {
  return inspectDestFile(resolveInside(dest, rel)).sha256;
}

function cleanTemps(dest: string, rel: string): void {
  const abs = resolveInside(dest, rel);
  const dir = path.dirname(abs);
  const prefix = `${path.basename(abs)}.capsule-tmp-`;
  try {
    for (const n of fs.readdirSync(dir)) if (n.startsWith(prefix)) fs.rmSync(path.join(dir, n), { force: true });
  } catch {
    // folder gone: nothing to clean
  }
}

export interface RollbackResult {
  restored: string[];
  keptModified: string[];
}

export function rollbackImport(importId: string, opts: { force?: boolean } = {}): RollbackResult {
  const j = loadJournal(importId);
  if (j.state === 'rolled-back') return { restored: [], keptModified: [] };
  const unlock = lockDestination(j.dest);
  try {
    j.state = 'rolling-back';
    saveJournal(j);
    const result: RollbackResult = { restored: [], keptModified: [] };
    const writtenSha = new Map(j.actions.filter((a) => a.type === 'write').map((a) => [a.path, (a as Extract<Action, { type: 'write' }>).writtenSha256]));
    for (const o of [...j.originals].reverse()) {
      cleanTemps(j.dest, o.path);
      const now = currentSha(j.dest, o.path);
      if (now === o.sha256) continue; // already original (or never touched)
      const ours = now === null || now === writtenSha.get(o.path);
      if (!ours && !opts.force) {
        result.keptModified.push(o.path);
        continue;
      }
      const abs = resolveInside(j.dest, o.path);
      if (o.existed) {
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = tempSibling(abs, 'capsule-tmp');
        fs.copyFileSync(backupPath(importId, o.path), tmp);
        renameWithRetry(tmp, abs);
      } else fs.rmSync(abs, { force: true });
      result.restored.push(o.path);
    }
    for (const dir of [...j.createdDirs].sort((a, b) => b.length - a.length)) {
      try {
        fs.rmdirSync(resolveInside(j.dest, dir));
      } catch {
        // not empty or already gone
      }
    }
    j.state = result.keptModified.length ? 'applied' : 'rolled-back';
    saveJournal(j);
    logEvent('import.rollback', { importId, restored: result.restored.length, keptModified: result.keptModified.length });
    return result;
  } finally {
    unlock();
  }
}

export function resumeImport(importId: string, c: OpenedCapsule): ApplyResult {
  const j = loadJournal(importId);
  if (!['prepared', 'applying'].includes(j.state)) throw new Error(`Import ${importId} is ${j.state}; only an interrupted apply can be resumed.`);
  if (c.manifest.capsuleId !== j.capsuleId) throw new Error('That capsule is not the one this import came from.');
  const unlock = lockDestination(j.dest);
  try {
    const originals = new Map(j.originals.map((o) => [o.path, o]));
    const createdDirs = new Set(j.createdDirs);
    j.state = 'applying';
    j.actions.forEach((a, i) => {
      cleanTemps(j.dest, a.path);
      const now = currentSha(j.dest, a.path);
      const o = originals.get(a.path);
      if (a.type === 'write') {
        if (now === a.writtenSha256) return;
        if (now !== (o?.sha256 ?? null)) throw new Error(`${a.path} changed since the interrupted import; roll back instead.`);
        writeTarget(j.dest, a, payloadFor(c, a), createdDirs);
      } else {
        if (now === null) return;
        if (now !== a.expectSha256) throw new Error(`${a.path} changed since the interrupted import; roll back instead.`);
        fs.rmSync(resolveInside(j.dest, a.path), { force: true });
      }
      if (!j.done.includes(i)) j.done.push(i);
      j.createdDirs = [...createdDirs];
      saveJournal(j);
    });
    j.state = 'applied';
    saveJournal(j);
    logEvent('import.resumed', { importId });
    return { importId, written: j.actions.filter((a) => a.type === 'write').length, deleted: j.actions.filter((a) => a.type === 'delete').length, skipped: [] };
  } finally {
    unlock();
  }
}

export function removeBackups(importId: string, opts: { force?: boolean } = {}): void {
  const j = loadJournal(importId);
  if (INTERRUPTED.includes(j.state) && !opts.force) throw new Error(`Import ${importId} is ${j.state}. Roll it back or resume it before removing its backups.`);
  fs.rmSync(importDir(importId), { recursive: true, force: true });
  logEvent('backups.removed', { importId });
}

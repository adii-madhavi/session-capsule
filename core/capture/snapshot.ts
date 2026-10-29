// Stable project snapshots. Each file is stat'ed before and after it is read,
// and everything is re-checked once the whole capture is done, so a file
// changed mid-capture is detected instead of packed half-written.

import fs from 'node:fs';
import path from 'node:path';
import { normSha256, sha256 } from '../common/hash.ts';
import { archivePathError } from '../common/paths.ts';
import { classify, exclusionRoot, type ExclusionRules } from './exclusions.ts';
import { readGitState, type GitState } from './git.ts';

export interface Candidate {
  rel: string;
  abs: string;
  // NFC form stored in the capsule (macOS may hand back NFD names).
  archivePath: string;
  size: number;
}

export interface CandidateList {
  candidates: Candidate[];
  excluded: Array<{ path: string; rule: string }>;
  skipped: Array<{ path: string; reason: string }>;
  git: GitState | null;
}

export interface ListOptions {
  include: string[];
  exclude: string[];
  maxFileSize: number;
}

function walk(root: string, rules: ExclusionRules, out: string[], excluded: Map<string, string>, skipped: Array<{ path: string; reason: string }>, rel = ''): void {
  for (const d of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
    const childRel = rel ? `${rel}/${d.name}` : d.name;
    const c = classify(childRel, rules);
    if (c) {
      excluded.set(d.isDirectory() ? childRel + '/' : childRel, c.rule);
      continue;
    }
    if (d.isSymbolicLink()) skipped.push({ path: childRel, reason: 'symbolic link (not followed or transferred)' });
    else if (d.isDirectory()) walk(root, rules, out, excluded, skipped, childRel);
    else if (d.isFile()) out.push(childRel);
    else skipped.push({ path: childRel, reason: 'special file (socket, device or pipe)' });
  }
}

export function listCandidates(root: string, opts: ListOptions): CandidateList {
  const git = readGitState(root);
  const rules: ExclusionRules = { include: opts.include, exclude: opts.exclude, tracked: git ? (p) => git.tracked.has(p) : undefined };
  const excluded = new Map<string, string>();
  const skipped: Array<{ path: string; reason: string }> = [];
  let rels: string[] = [];

  if (git) {
    for (const rel of git.listed) {
      const c = classify(rel, rules);
      if (c) excluded.set(c.kind === 'credential' ? rel : exclusionRoot(rel, rules), c.rule);
      else rels.push(rel);
    }
  } else walk(root, rules, rels, excluded, skipped);

  const candidates: Candidate[] = [];
  rels = rels.sort();
  for (const rel of rels) {
    const abs = path.join(root, ...rel.split('/'));
    const st = fs.lstatSync(abs, { throwIfNoEntry: false });
    if (!st) continue; // deleted in the working tree; handled as a deletion
    if (st.isSymbolicLink()) skipped.push({ path: rel, reason: 'symbolic link (not followed or transferred)' });
    else if (st.isDirectory()) skipped.push({ path: rel, reason: 'git submodule or nested repository (not captured)' });
    else if (!st.isFile()) skipped.push({ path: rel, reason: 'special file (socket, device or pipe)' });
    else if (st.size > opts.maxFileSize) skipped.push({ path: rel, reason: `larger than ${Math.round(opts.maxFileSize / 1048576)} MiB` });
    else {
      const archivePath = rel.normalize('NFC');
      const problem = archivePathError(archivePath);
      if (problem) skipped.push({ path: rel, reason: `unsupported file name (${problem})` });
      else candidates.push({ rel, abs, archivePath, size: st.size });
    }
  }
  return {
    candidates,
    excluded: [...excluded].map(([p, rule]) => ({ path: p, rule })).sort((a, b) => a.path.localeCompare(b.path)),
    skipped,
    git,
  };
}

export interface CapturedFile {
  path: string;
  sha256: string;
  normSha256: string | null;
  size: number;
  executable: boolean;
}

interface StatKey {
  size: number;
  mtimeMs: number;
  ino: number;
}

const keyOf = (st: fs.Stats): StatKey => ({ size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
const sameKey = (a: StatKey, b: StatKey) => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

export interface CaptureResult {
  files: CapturedFile[];
  unstable: string[];
}

export function captureFiles(
  list: Candidate[],
  isExecutable: (c: Candidate, st: fs.Stats) => boolean,
  sink: ((c: Candidate, data: Buffer, executable: boolean) => void) | null,
  afterFile?: (rel: string) => void,
): CaptureResult {
  const files: CapturedFile[] = [];
  const unstable: string[] = [];
  const keys = new Map<string, StatKey>();
  for (const c of list) {
    const before = fs.lstatSync(c.abs, { throwIfNoEntry: false });
    if (!before?.isFile()) {
      unstable.push(c.rel);
      continue;
    }
    const data = fs.readFileSync(c.abs);
    const after = fs.lstatSync(c.abs, { throwIfNoEntry: false });
    if (!after || !sameKey(keyOf(before), keyOf(after)) || data.length !== after.size) {
      unstable.push(c.rel);
      continue;
    }
    const executable = isExecutable(c, after);
    sink?.(c, data, executable);
    keys.set(c.rel, keyOf(after));
    files.push({ path: c.archivePath, sha256: sha256(data), normSha256: normSha256(data), size: data.length, executable });
    afterFile?.(c.rel);
  }
  for (const c of list) {
    const k = keys.get(c.rel);
    if (!k) continue;
    const now = fs.lstatSync(c.abs, { throwIfNoEntry: false });
    if (!now || !sameKey(k, keyOf(now))) unstable.push(c.rel);
  }
  return { files, unstable: [...new Set(unstable)] };
}

// Hash of the sorted (path, content hash) list: identifies the project state.
export function fingerprint(files: Array<{ path: string; sha256: string }>): string {
  return sha256([...files].sort((a, b) => (a.path < b.path ? -1 : 1)).map((f) => `${f.path}\0${f.sha256}\n`).join(''));
}

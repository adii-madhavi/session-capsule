// Import preview: compares every capsule file and recorded deletion with the
// destination and decides what is safe. Nothing here writes.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { eolStyle, isText, normSha256, sha256 } from '../common/hash.ts';
import { DestinationInspector, currentPlatform, platformIssues, resolveInside } from '../common/paths.ts';
import { samePath } from '../common/fsx.ts';
import type { OpenedCapsule } from '../archive/capsule.ts';
import type { CaptureMode, FileEntry, Platform, PlatformIssue } from '../common/types.ts';
import { listImports, type ImportSummary } from './journal.ts';

export type PlanOp =
  | { kind: 'create'; path: string; sha256: string; executable: boolean }
  | { kind: 'update'; path: string; sha256: string; destSha256: string; executable: boolean; matchCrlf: boolean }
  | { kind: 'unchanged'; path: string; note: string | null }
  | { kind: 'conflict'; path: string; sha256: string; destSha256: string; executable: boolean; reason: string }
  | { kind: 'delete'; path: string; destSha256: string }
  | { kind: 'delete-conflict'; path: string; destSha256: string; reason: string }
  | { kind: 'already-deleted'; path: string }
  | { kind: 'blocked'; path: string; reason: string };

export interface ProjectCheck {
  destIsGit: boolean;
  destHead: string | null;
  destBranch: string | null;
  destDirty: boolean | null;
  sourceHead: string | null;
  sourceBranch: string | null;
  sameCommit: boolean | null;
}

export interface ImportPlan {
  capsuleId: string;
  mode: CaptureMode;
  dest: string;
  platform: Platform;
  ops: PlanOp[];
  warnings: PlatformIssue[];
  project: ProjectCheck;
  previousImports: ImportSummary[];
  counts: Record<PlanOp['kind'], number>;
}

export interface DestFile {
  exists: boolean;
  isFile: boolean;
  sha256: string | null;
  normSha256: string | null;
  crlf: boolean;
}

export function inspectDestFile(abs: string): DestFile {
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) return { exists: false, isFile: false, sha256: null, normSha256: null, crlf: false };
  if (!st.isFile()) return { exists: true, isFile: false, sha256: null, normSha256: null, crlf: false };
  const data = fs.readFileSync(abs);
  return { exists: true, isFile: true, sha256: sha256(data), normSha256: normSha256(data), crlf: isText(data) && eolStyle(data) === 'crlf' };
}

function git(dest: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, { cwd: dest, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch {
    return null;
  }
}

function projectCheck(c: OpenedCapsule, dest: string): ProjectCheck {
  const isGit = git(dest, ['rev-parse', '--is-inside-work-tree']) === 'true';
  const destHead = isGit ? git(dest, ['rev-parse', '-q', '--verify', 'HEAD']) || null : null;
  const src = c.manifest.project.git;
  return {
    destIsGit: isGit,
    destHead,
    destBranch: isGit ? git(dest, ['symbolic-ref', '--short', '-q', 'HEAD']) || null : null,
    destDirty: isGit ? (git(dest, ['status', '--porcelain']) ?? '').length > 0 : null,
    sourceHead: src?.head ?? null,
    sourceBranch: src?.branch ?? null,
    sameCommit: src?.head && destHead ? src.head === destHead : null,
  };
}

const same = (d: DestFile, sha: string, norm: string | null) => d.sha256 === sha || (!!norm && d.normSha256 === norm);

function planEntry(e: FileEntry, d: DestFile): PlanOp {
  if (!d.exists) return { kind: 'create', path: e.path, sha256: e.sha256, executable: e.executable };
  if (!d.isFile) return { kind: 'blocked', path: e.path, reason: 'the destination has a folder or special file here' };
  if (same(d, e.sha256, e.normSha256)) {
    return { kind: 'unchanged', path: e.path, note: d.sha256 === e.sha256 ? null : 'same content; only line endings differ, so the destination copy is kept' };
  }
  if (e.baseSha256 && same(d, e.baseSha256, e.baseNormSha256)) {
    return { kind: 'update', path: e.path, sha256: e.sha256, destSha256: d.sha256 as string, executable: e.executable, matchCrlf: d.crlf };
  }
  return {
    kind: 'conflict',
    path: e.path,
    sha256: e.sha256,
    destSha256: d.sha256 as string,
    executable: e.executable,
    reason: e.baseSha256
      ? 'both computers changed this file since the last commit'
      : 'the destination has a different version, and there is no recorded common version to compare with',
  };
}

export function planImport(c: OpenedCapsule, dest: string, platform: Platform = currentPlatform()): ImportPlan {
  if (!fs.statSync(dest, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`${dest} is not a folder. Choose an existing destination folder.`);
  const paths = [...c.files.entries.map((e) => e.path), ...c.files.deletions.map((d) => d.path)];
  const issues = platformIssues(paths, platform);
  const inspector = new DestinationInspector(dest, platform);
  const blocking = new Map<string, string>();
  const warnings: PlatformIssue[] = [];
  for (const i of issues) (i.blocking ? blocking.set(i.path, i.detail) : warnings.push(i));
  for (const p of paths) for (const i of inspector.issuesFor(p)) (i.blocking ? blocking.set(i.path, i.detail) : warnings.push(i));

  const ops: PlanOp[] = [];
  for (const e of c.files.entries) {
    if (blocking.has(e.path)) ops.push({ kind: 'blocked', path: e.path, reason: blocking.get(e.path) as string });
    else ops.push(planEntry(e, inspectDestFile(resolveInside(dest, e.path))));
  }
  for (const del of c.files.deletions) {
    if (blocking.has(del.path)) {
      ops.push({ kind: 'blocked', path: del.path, reason: blocking.get(del.path) as string });
      continue;
    }
    const d = inspectDestFile(resolveInside(dest, del.path));
    if (!d.exists) ops.push({ kind: 'already-deleted', path: del.path });
    else if (!d.isFile) ops.push({ kind: 'blocked', path: del.path, reason: 'the destination has a folder or special file here' });
    else if (same(d, del.baseSha256, del.baseNormSha256)) ops.push({ kind: 'delete', path: del.path, destSha256: d.sha256 as string });
    else ops.push({ kind: 'delete-conflict', path: del.path, destSha256: d.sha256 as string, reason: 'deleted on the source, but changed at the destination' });
  }

  const counts = { create: 0, update: 0, unchanged: 0, conflict: 0, delete: 0, 'delete-conflict': 0, 'already-deleted': 0, blocked: 0 };
  for (const op of ops) counts[op.kind]++;
  return {
    capsuleId: c.manifest.capsuleId,
    mode: c.manifest.mode,
    dest,
    platform,
    ops,
    warnings,
    project: projectCheck(c, dest),
    previousImports: listImports().filter((i) => i.capsuleId === c.manifest.capsuleId && samePath(i.dest, dest)),
    counts,
  };
}

// For context-only capsules: which recorded files match and why others don't.
export interface ContextReport {
  matching: number;
  missing: string[];
  different: string[];
  uncommittedOnSource: string[];
  notYetDeleted: string[];
  explanation: string[];
}

export function contextReport(c: OpenedCapsule, plan: ImportPlan): ContextReport {
  const status = new Map(c.files.entries.map((e) => [e.path, e.status]));
  const missing = plan.ops.filter((o) => o.kind === 'create').map((o) => o.path);
  const different = plan.ops.filter((o) => o.kind === 'update' || o.kind === 'conflict' || o.kind === 'blocked').map((o) => o.path);
  const notYetDeleted = plan.ops.filter((o) => o.kind === 'delete' || o.kind === 'delete-conflict').map((o) => o.path);
  const uncommittedOnSource = [...missing, ...different].filter((p) => ['modified', 'added', 'untracked'].includes(status.get(p) ?? ''));
  const matching = plan.counts.unchanged;
  const explanation: string[] = [];
  if (!missing.length && !different.length && !notYetDeleted.length) explanation.push(`All ${matching} recorded files match the source. The project is ready to continue.`);
  else {
    explanation.push(`${matching} of ${c.files.entries.length} recorded files match; ${missing.length} are missing and ${different.length} differ.`);
    if (plan.project.sameCommit === false) explanation.push(`This folder is on commit ${plan.project.destHead?.slice(0, 12)}, but the source was on ${plan.project.sourceHead?.slice(0, 12)}. Check out or pull that commit first.`);
    if (!plan.project.destIsGit && c.manifest.project.git) explanation.push('The source was a git repository, but this folder is not.');
    if (uncommittedOnSource.length) explanation.push(`${uncommittedOnSource.length} of these had uncommitted changes on the source, so a pull can't bring them. Move them separately or use a full capsule.`);
    if (notYetDeleted.length) explanation.push(`${notYetDeleted.length} files were deleted on the source but still exist here.`);
    explanation.push('Continue only after these differences are resolved, or tell the agent which version is correct.');
  }
  return { matching, missing, different, uncommittedOnSource, notYetDeleted, explanation };
}

// Read-only git queries on the source project. Git is optional; without it the
// capture is a plain snapshot with no base versions and no deletions.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { normSha256, sha256 } from '../common/hash.ts';
import type { GitInfo } from '../common/types.ts';

export interface GitState {
  info: GitInfo;
  prefix: string;
  listed: string[];
  tracked: Set<string>;
  executable: Set<string>;
  status: Map<string, string>;
  deleted: string[];
}

function git(cwd: string, args: string[], input?: string): Buffer {
  return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
    cwd,
    input,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 1024 ** 3,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args).toString('utf8').trim() || null;
  } catch {
    return null;
  }
}

// Credentials embedded in a remote URL are never recorded.
export function sanitizeRemote(url: string | null): string | null {
  if (!url) return null;
  return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
}

const nulList = (buf: Buffer) => buf.toString('utf8').split('\0').filter(Boolean);

export function readGitState(root: string): GitState | null {
  if (tryGit(root, ['rev-parse', '--is-inside-work-tree']) !== 'true') return null;
  const prefix = tryGit(root, ['rev-parse', '--show-prefix']) ?? '';
  const strip = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : null);
  const head = tryGit(root, ['rev-parse', '-q', '--verify', 'HEAD']);

  const listed = [...new Set(nulList(git(root, ['ls-files', '-z', '--full-name', '--cached', '--others', '--exclude-standard', '--', '.'])).map(strip).filter((p): p is string => !!p))];

  const tracked = new Set<string>();
  const executable = new Set<string>();
  for (const line of nulList(git(root, ['ls-files', '-z', '-s', '--full-name', '--', '.']))) {
    const tab = line.indexOf('\t');
    const rel = strip(line.slice(tab + 1));
    if (!rel) continue;
    tracked.add(rel);
    if (line.startsWith('100755')) executable.add(rel);
  }

  const status = new Map<string, string>();
  const raw = git(root, ['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all', '--', '.']);
  for (const item of nulList(raw)) {
    const rel = strip(item.slice(3));
    if (rel) status.set(rel, item.slice(0, 2));
  }
  const deleted = head
    ? [...status.entries()].filter(([p, xy]) => xy.includes('D') && xy !== 'AD' && !fs.existsSync(path.join(root, ...p.split('/')))).map(([p]) => p)
    : [];

  return {
    info: {
      head,
      branch: tryGit(root, ['symbolic-ref', '--short', '-q', 'HEAD']),
      remote: sanitizeRemote(tryGit(root, ['remote', 'get-url', 'origin'])),
      dirty: raw.length > 0,
    },
    prefix,
    listed,
    tracked,
    executable,
    status,
    deleted,
  };
}

export function fileStatus(xy: string | undefined): 'unchanged' | 'modified' | 'added' | 'untracked' {
  if (!xy) return 'unchanged';
  if (xy === '??') return 'untracked';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

// Hashes of the committed (HEAD) version of each path, read with one cat-file call.
export function headVersions(root: string, state: GitState, paths: string[]): Map<string, { sha256: string; normSha256: string | null }> {
  const out = new Map<string, { sha256: string; normSha256: string | null }>();
  const usable = paths.filter((p) => !p.includes('\n'));
  if (!state.info.head || usable.length === 0) return out;
  const buf = git(root, ['cat-file', '--batch'], usable.map((p) => `HEAD:${state.prefix}${p}`).join('\n') + '\n');
  let pos = 0;
  for (const p of usable) {
    const nl = buf.indexOf(10, pos);
    const header = buf.subarray(pos, nl).toString('utf8');
    pos = nl + 1;
    const m = header.match(/^[0-9a-f]+ blob (\d+)$/);
    if (!m) continue;
    const size = Number(m[1]);
    const data = buf.subarray(pos, pos + size);
    pos += size + 1;
    out.set(p, { sha256: sha256(data), normSha256: normSha256(data) });
  }
  return out;
}

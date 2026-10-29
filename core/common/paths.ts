import fs from 'node:fs';
import path from 'node:path';
import type { Platform, PlatformIssue } from './types.ts';

// Rules for paths stored inside a capsule. A path that fails these is never
// written anywhere: the whole capsule is rejected.
export function archivePathError(p: string): string | null {
  if (typeof p !== 'string' || p.length === 0) return 'empty path';
  if (p.length > 1024) return 'path is longer than 1024 characters';
  if (p.includes('\0')) return 'contains a NUL character';
  if (p.includes('\\')) return 'contains a backslash';
  if (p.startsWith('/')) return 'is an absolute path';
  if (/^[A-Za-z]:/.test(p)) return 'starts with a drive letter';
  const segments = p.split('/');
  for (const s of segments) {
    if (s === '') return 'has an empty path segment';
    if (s === '.' || s === '..') return 'contains a relative path segment';
  }
  // Windows ignores trailing dots/spaces and treats "name:stream" as name, so
  // ".git.", ".GIT " and ".git::$INDEX_ALLOCATION" all mean ".git" there.
  const canonical = segments.map((s) => s.split(':')[0].replace(/[. ]+$/, '').toLowerCase());
  if (canonical.some((s) => s === '.git' || s === 'git~1')) return 'points into a .git folder';
  if (canonical[0] === '.session-capsule') return 'points into the Session Capsule folder';
  if (p !== p.normalize('NFC')) return 'is not in Unicode NFC form';
  return null;
}

const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)$/i;
const WIN_INVALID = /[<>:"|?*\u0000-\u001f]/;

function utf8Length(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

export function foldPath(p: string): string {
  return p.normalize('NFC').toLowerCase();
}

// Problems a set of relative paths would have on a given platform.
export function platformIssues(paths: string[], platform: Platform): PlatformIssue[] {
  const issues: PlatformIssue[] = [];
  const add = (p: string, kind: PlatformIssue['kind'], blocking: boolean, detail: string) =>
    issues.push({ path: p, platform, kind, blocking, detail });

  for (const p of paths) {
    for (const seg of p.split('/')) {
      if (utf8Length(seg) > 255) add(p, 'invalid-name', true, `name "${seg.slice(0, 40)}…" is longer than 255 bytes`);
      if (platform !== 'win32') continue;
      if (WIN_INVALID.test(seg)) add(p, 'invalid-name', true, `"${seg}" contains a character Windows doesn't allow (< > : " | ? * or a control character)`);
      else if (/[. ]$/.test(seg)) add(p, 'invalid-name', true, `"${seg}" ends with a dot or space, which Windows removes`);
      if (WIN_RESERVED.test(seg.split('.')[0])) add(p, 'reserved-name', true, `"${seg}" uses a name Windows reserves for devices`);
    }
    if (platform === 'win32' && p.length > 240) {
      add(p, 'too-long', false, 'path may exceed the 260-character Windows limit once the destination folder is added');
    }
  }

  if (platform === 'win32' || platform === 'darwin') {
    const seen = new Map<string, string>();
    const reported = new Set<string>();
    for (const p of paths) {
      const segs = p.split('/');
      for (let i = 1; i <= segs.length; i++) {
        const prefix = segs.slice(0, i).join('/');
        const key = foldPath(prefix);
        const prior = seen.get(key);
        if (prior === undefined) seen.set(key, prefix);
        else if (prior !== prefix && !reported.has(key)) {
          reported.add(key);
          const isFile = i === segs.length;
          if (isFile) {
            // Block both files: whichever was written last would silently win.
            const detail = `"${prefix}" and "${prior}" differ only by letter case and would be the same file`;
            add(p, 'case-collision', true, detail);
            add(prior, 'case-collision', true, detail);
          } else add(p, 'case-collision', false, `folders "${prefix}" and "${prior}" differ only by letter case and would be merged`);
        }
      }
    }
  }
  return issues;
}

// Checks against what already exists at the destination: case-only name
// mismatches, symlinked parent folders and files where folders should be.
export class DestinationInspector {
  #root: string;
  #platform: Platform;
  #listings = new Map<string, Map<string, string> | null>();

  constructor(root: string, platform: Platform) {
    this.#root = root;
    this.#platform = platform;
  }

  #list(dir: string): Map<string, string> | null {
    if (!this.#listings.has(dir)) {
      let names: string[] | null = null;
      try {
        names = fs.readdirSync(dir);
      } catch {
        names = null;
      }
      this.#listings.set(dir, names ? new Map(names.map((n) => [foldPath(n), n])) : null);
    }
    return this.#listings.get(dir) ?? null;
  }

  issuesFor(rel: string): PlatformIssue[] {
    const issues: PlatformIssue[] = [];
    const segs = rel.split('/');
    let dir = this.#root;
    for (let i = 0; i < segs.length; i++) {
      const seg = segs[i];
      const isLast = i === segs.length - 1;
      const listing = this.#list(dir);
      if (!listing) break;
      const existing = listing.get(foldPath(seg));
      if (existing === undefined) break;
      if (existing.normalize('NFC') !== seg.normalize('NFC') && this.#platform !== 'linux') {
        issues.push({
          path: rel,
          platform: this.#platform,
          kind: 'existing-case-mismatch',
          blocking: true,
          detail: `the destination already has "${segs.slice(0, i).concat(existing).join('/')}", which differs only by letter case`,
        });
        break;
      }
      const full = path.join(dir, existing);
      const st = fs.lstatSync(full, { throwIfNoEntry: false });
      if (!st) break;
      if (st.isSymbolicLink()) {
        issues.push({
          path: rel,
          platform: this.#platform,
          kind: 'symlink-parent',
          blocking: true,
          detail: `"${segs.slice(0, i + 1).join('/')}" is a symbolic link at the destination; Session Capsule won't write through links`,
        });
        break;
      }
      if (isLast ? !st.isFile() : !st.isDirectory()) {
        issues.push({
          path: rel,
          platform: this.#platform,
          kind: 'not-a-file',
          blocking: true,
          detail: isLast
            ? 'the destination has a folder or special file at this path'
            : `"${segs.slice(0, i + 1).join('/')}" is a file at the destination, not a folder`,
        });
        break;
      }
      dir = full;
    }
    return issues;
  }
}

// Resolve a validated relative path under root and make sure it stays there.
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, ...rel.split('/'));
  const base = path.resolve(root);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`path escapes the destination: ${rel}`);
  return abs;
}

export function currentPlatform(): Platform {
  return process.platform === 'win32' ? 'win32' : process.platform === 'darwin' ? 'darwin' : 'linux';
}

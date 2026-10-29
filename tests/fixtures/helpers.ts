// Test fixtures: throwaway projects, git repos, and hand-built (including hostile) capsules.

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ZipWriter } from '../../core/archive/zip.ts';
import { sha256, normSha256 } from '../../core/common/hash.ts';
import { pack, type PackOptions } from '../../core/pack.ts';
import type { ConversationDoc, EnvironmentInfo, FileEntry, FilesIndex, HandoffObject, Manifest } from '../../core/common/types.ts';

export function tmpDir(prefix = 'sc-test'): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`)));
}

// Each test file gets its own data folder (journals, backups, logs).
export function isolateAppHome(): string {
  const home = tmpDir('sc-home');
  process.env.SESSION_CAPSULE_HOME = home;
  return home;
}

export function writeFiles(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, data] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, data);
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

export function gitProject(files: Record<string, string | Buffer>): string {
  const root = tmpDir('sc-src');
  writeFiles(root, files);
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', 'base');
  return root;
}

export function cloneOf(root: string): string {
  const dest = path.join(tmpDir('sc-dest'), 'clone');
  git(path.dirname(dest), 'clone', '-q', root, dest);
  return dest;
}

export function read(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
}

export async function packTo(opts: Partial<PackOptions> & { projectRoot: string }): Promise<string> {
  const out = path.join(tmpDir('sc-out'), 'test.capsule');
  await pack({ mode: 'full', tool: 'manual', scryptN: 2 ** 10, retryDelayMs: 1, ...opts, out });
  return out;
}

// Snapshot of every file under a folder (path -> hash), to prove "nothing was written".
export function treeHash(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (d.name === '.git') continue;
      const p = path.join(dir, d.name);
      if (d.isDirectory()) walk(p);
      else out[path.relative(root, p)] = sha256(fs.readFileSync(p));
    }
  };
  walk(root);
  return out;
}

export interface ForgeOptions {
  files?: Array<{ path: string; data: Buffer | string; status?: FileEntry['status']; base?: string | null; inPayload?: boolean }>;
  deletions?: FilesIndex['deletions'];
  manifest?: Partial<Manifest>;
  environment?: Partial<EnvironmentInfo>;
  rawEntries?: Array<{ name: string; data: Buffer; unixMode?: number }>;
  mode?: Manifest['mode'];
}

// Builds a capsule by hand, bypassing pack(), so tests can create hostile or
// unusual archives (unsafe paths, wrong versions, links, collisions).
export function forgeCapsule(opts: ForgeOptions = {}): string {
  const out = path.join(tmpDir('sc-forge'), 'forged.capsule');
  const zip = new ZipWriter(out);
  const capsuleId = randomUUID();
  const mode = opts.mode ?? 'full';
  const entries: FileEntry[] = (opts.files ?? []).map((f) => {
    const data = Buffer.from(f.data);
    const inPayload = f.inPayload ?? mode === 'full';
    if (inPayload) zip.add(`session-capsule/payload/${f.path}`, data);
    return {
      path: f.path,
      sha256: sha256(data),
      normSha256: normSha256(data),
      size: data.length,
      executable: false,
      status: f.status ?? 'unknown',
      baseSha256: f.base ?? null,
      baseNormSha256: null,
      inPayload,
    };
  });
  for (const r of opts.rawEntries ?? []) zip.add(r.name, r.data, { unixMode: r.unixMode });
  const files: FilesIndex = { entries, deletions: opts.deletions ?? [], excluded: [], skipped: [], platformIssues: [] };
  const conversation: ConversationDoc = {
    origin: { tool: 'manual', surface: 'unknown', sessionId: null, title: null, toolVersion: null, extractedFrom: 'test' },
    completeness: 'unavailable',
    notes: [],
    messages: [],
  };
  const environment: EnvironmentInfo = { source: { platform: 'darwin', arch: 'arm64' }, tools: [], detected: [], steps: [], envVarNames: [], excludedCredentials: [], notes: [], ...opts.environment };
  const handoff: HandoffObject = {
    kind: 'session-capsule.handoff',
    version: '1.0',
    handoffId: randomUUID(),
    createdBy: { name: 'test', version: '0' },
    capturedAt: new Date().toISOString(),
    source: { tool: 'manual', surface: 'unknown', platform: 'darwin', toolVersion: null, model: null },
    session: { originalId: null, originalRef: null, sourceProjectPath: null, firstRecordedAt: null, lastRecordedAt: null },
    events: null,
    checkpoint: null,
    sourceStatusAtCapture: null,
    coverage: { history: 'unavailable', truncation: [], missing: [] },
    notes: null,
    capsule: null,
  };
  const meta: Record<string, string> = {
    'files.json': JSON.stringify(files),
    'conversation.json': JSON.stringify(conversation),
    'continuation.md': '# Continuation note\n',
    'environment.json': JSON.stringify(environment),
    'handoff.json': JSON.stringify(handoff),
  };
  const integrity = Object.entries(meta).map(([name, text]) => {
    const b = Buffer.from(text);
    zip.add(`session-capsule/${name}`, b);
    return { path: name, sha256: sha256(b), size: b.length };
  });
  const manifest: Manifest = {
    format: 'session-capsule',
    formatVersion: '1.0',
    capsuleId,
    createdAt: new Date().toISOString(),
    createdBy: 'test',
    mode,
    tool: { id: 'manual', surface: 'unknown', version: null },
    source: { platform: 'darwin', arch: 'arm64' },
    project: { name: 'forged', git: null, fingerprint: '0'.repeat(64), fileCount: entries.length, totalBytes: 0 },
    conversation: { completeness: 'unavailable', sessionId: null, title: null, messageCount: 0, redactions: 0 },
    restoration: { native: 'unsupported', note: 'test' },
    integrity,
    ...opts.manifest,
  };
  zip.add('session-capsule/manifest.json', Buffer.from(JSON.stringify(manifest)));
  zip.finish();
  return out;
}

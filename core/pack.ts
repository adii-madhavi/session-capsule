// Pack: build a capsule on the source computer. reviewPack() shows exactly what
// would transfer without writing anything; pack() captures and writes it.

import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { claudeCodeAdapter } from '../adapters/claude-code/index.ts';
import { codexAdapter } from '../adapters/codex/index.ts';
import { fromTranscript, noHistory } from '../adapters/manual/index.ts';
import { capsuleSurface, conversationFromHandoff, readHandoff } from '../adapters/blocker/index.ts';
import { DEFAULT_EXTRACT, type Adapter, type ExtractOptions, type SessionSummary } from '../adapters/types.ts';
import { CapsuleWriter, finalizeCapsule } from './archive/capsule.ts';
import { DEFAULT_SCRYPT_N } from './archive/encryption.ts';
import { headVersions, fileStatus } from './capture/git.ts';
import { captureFiles, fingerprint, listCandidates, type CandidateList } from './capture/snapshot.ts';
import { isText } from './common/hash.ts';
import { logEvent } from './common/log.ts';
import { platformIssues } from './common/paths.ts';
import { findSecrets, redactSecrets } from './common/secrets.ts';
import {
  ENGINE_VERSION,
  FORMAT_NAME,
  FORMAT_VERSION,
  HANDOFF_KIND,
  HANDOFF_VERSION,
  type CaptureMode,
  type ConversationDoc,
  type FileEntry,
  type FilesIndex,
  type HandoffObject,
  type HandoffSurface,
  type Manifest,
  type PlatformIssue,
  type Surface,
  type ToolId,
} from './common/types.ts';
import { redactConversation, renderConversationMarkdown } from './handoff/conversation.ts';
import { buildContinuation } from './handoff/continuation.ts';
import { detectEnvironment } from './handoff/environment.ts';

export const ADAPTERS: Record<string, Adapter> = { 'claude-code': claudeCodeAdapter, codex: codexAdapter };

export interface PackOptions {
  projectRoot: string;
  mode: CaptureMode;
  tool?: ToolId;
  session?: string | null;
  transcriptPath?: string | null;
  notePath?: string | null;
  handoffPath?: string | null;
  include?: string[];
  exclude?: string[];
  maxFileSize?: number;
  fullToolOutput?: boolean;
  out: string;
  passphrase?: string | null;
  scryptN?: number;
  retries?: number;
  retryDelayMs?: number;
  hooks?: { afterFile?: (rel: string, attempt: number) => void };
}

export class CaptureUnstableError extends Error {
  paths: string[];
  constructor(paths: string[]) {
    super(`Files kept changing while they were being captured: ${paths.slice(0, 10).join(', ')}${paths.length > 10 ? ', …' : ''}. Pause the coding agent and any editors or build watchers, then try again.`);
    this.paths = paths;
  }
}

interface Context {
  tool: ToolId;
  surface: Surface;
  toolVersion: string | null;
  session: SessionSummary | null;
  conversation: ConversationDoc;
  redactions: number;
  handoffIn: HandoffObject | null;
  userNote: string | null;
  warnings: string[];
}

function resolveSession(adapter: Adapter, root: string, wanted: string | null | undefined): SessionSummary | null {
  const sessions = adapter.listSessions(root);
  if (!wanted || wanted === 'latest') return sessions[0] ?? null;
  const s = sessions.find((x) => x.id === wanted || x.id.startsWith(wanted));
  if (!s) throw new Error(`No ${adapter.label} session ${wanted} was found for this project. List them with: capsule sessions --tool ${adapter.id} --project <folder>`);
  return s;
}

function prepareContext(opts: PackOptions): Context {
  const extract: ExtractOptions = opts.fullToolOutput ? { maxToolOutput: 200_000, maxToolInput: 200_000 } : DEFAULT_EXTRACT;
  const warnings: string[] = [];
  const handoffIn = opts.handoffPath ? readHandoff(opts.handoffPath) : null;
  let tool: ToolId = opts.tool ?? handoffIn?.source.tool ?? 'manual';
  let surface: Surface = handoffIn ? capsuleSurface(handoffIn) : 'unknown';
  let toolVersion = handoffIn?.source.toolVersion ?? null;
  let session: SessionSummary | null = null;
  let conversation: ConversationDoc;

  if (handoffIn?.session.sourceProjectPath && path.resolve(handoffIn.session.sourceProjectPath) !== path.resolve(opts.projectRoot)) {
    warnings.push(`The handoff was recorded for ${handoffIn.session.sourceProjectPath}, but you are packing ${opts.projectRoot}.`);
  }
  if (opts.transcriptPath) conversation = fromTranscript(opts.transcriptPath, tool, surface);
  else if (ADAPTERS[tool] && (!handoffIn || opts.session)) {
    session = resolveSession(ADAPTERS[tool], opts.projectRoot, opts.session);
    if (session) {
      conversation = ADAPTERS[tool].extract(session, extract);
      surface = session.surface;
      toolVersion = session.toolVersion;
    } else {
      conversation = noHistory(tool, surface, `No ${ADAPTERS[tool].label} session was found for this project. Supply a transcript with --transcript if you have one.`);
      warnings.push(conversation.notes[0]);
    }
  } else if (handoffIn) conversation = conversationFromHandoff(handoffIn, extract);
  else {
    tool = opts.tool ?? 'manual';
    conversation = noHistory(tool, surface, 'No conversation history was supplied.');
  }
  const { doc, redactions } = redactConversation(conversation);
  const userNote = opts.notePath ? fs.readFileSync(opts.notePath, 'utf8') : handoffIn?.notes ?? null;
  return { tool, surface, toolVersion, session, conversation: doc, redactions, handoffIn, userNote, warnings };
}

export interface PackReview {
  projectRoot: string;
  mode: CaptureMode;
  tool: ToolId;
  surface: Surface;
  session: SessionSummary | null;
  included: Array<{ path: string; size: number }>;
  totalBytes: number;
  excluded: Array<{ path: string; rule: string }>;
  skipped: Array<{ path: string; reason: string }>;
  deletions: string[];
  platformIssues: PlatformIssue[];
  fileSecretFindings: Array<{ path: string; line: number; type: string }>;
  conversation: ConversationDoc;
  redactions: number;
  noteSupplied: boolean;
  missingNoteSections: string[];
  recorderCheckpoint: boolean;
  warnings: string[];
  git: CandidateList['git'];
}

function listOpts(opts: PackOptions) {
  return { include: opts.include ?? [], exclude: opts.exclude ?? [], maxFileSize: opts.maxFileSize ?? 100 * 1024 * 1024 };
}

export function reviewPack(opts: PackOptions): PackReview {
  const ctx = prepareContext(opts);
  const list = listCandidates(opts.projectRoot, listOpts(opts));
  const findings: PackReview['fileSecretFindings'] = [];
  for (const c of list.candidates) {
    if (c.size > 2 * 1024 * 1024) continue;
    const data = fs.readFileSync(c.abs);
    if (!isText(data)) continue;
    for (const f of findSecrets(data.toString('utf8'), 5)) findings.push({ path: c.archivePath, ...f });
  }
  const paths = list.candidates.map((c) => c.archivePath);
  const note = buildContinuation({
    capsuleId: '-',
    createdAt: '-',
    mode: opts.mode,
    sourceLabel: '-',
    userNote: ctx.userNote,
    git: list.git?.info ?? null,
    files: { entries: [], deletions: [], excluded: [], skipped: [], platformIssues: [] },
    conversation: ctx.conversation,
    handoff: ctx.handoffIn,
  });
  return {
    projectRoot: opts.projectRoot,
    mode: opts.mode,
    tool: ctx.tool,
    surface: ctx.surface,
    session: ctx.session,
    included: list.candidates.map((c) => ({ path: c.archivePath, size: c.size })),
    totalBytes: list.candidates.reduce((n, c) => n + c.size, 0),
    excluded: list.excluded,
    skipped: list.skipped,
    deletions: list.git?.deleted ?? [],
    platformIssues: [...platformIssues(paths, 'win32'), ...platformIssues(paths, 'darwin')],
    fileSecretFindings: findings,
    conversation: ctx.conversation,
    redactions: ctx.redactions,
    noteSupplied: !!ctx.userNote,
    missingNoteSections: note.missingSections,
    recorderCheckpoint: !!ctx.handoffIn?.checkpoint,
    warnings: ctx.warnings,
    git: list.git,
  };
}

function handoffSurface(tool: ToolId, surface: Surface): HandoffSurface {
  if (tool === 'codex') return surface === 'desktop' ? 'codex-desktop' : surface === 'cli' ? 'codex-cli' : 'unknown';
  if (tool === 'claude-code') return surface === 'desktop' ? 'claude-code-desktop' : surface === 'cli' ? 'claude-code-cli' : surface === 'ide' ? 'claude-code-ide' : 'unknown';
  return 'unknown';
}

// Defense in depth at the boundary: redact every string the recorder exported.
function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redactSecrets(value).text as T;
  if (Array.isArray(value)) return value.map(redactDeep) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)])) as T;
  return value;
}

export interface PackResult {
  file: string;
  manifest: Manifest;
  files: FilesIndex;
  attempts: number;
  missingNoteSections: string[];
  warnings: string[];
}

export async function pack(opts: PackOptions): Promise<PackResult> {
  const root = path.resolve(opts.projectRoot);
  if (!fs.statSync(root).isDirectory()) throw new Error(`${root} is not a folder.`);
  const out = path.resolve(opts.out);
  if (fs.existsSync(out)) throw new Error(`${out} already exists. Choose another name.`);
  const ctx = prepareContext({ ...opts, projectRoot: root });
  const retries = opts.retries ?? 3;

  for (let attempt = 1; ; attempt++) {
    const list = listCandidates(root, listOpts(opts));
    const headBefore = list.git?.info.head ?? null;
    const tmp = `${out}.partial-${randomBytes(4).toString('hex')}`;
    const writer = new CapsuleWriter(tmp);
    try {
      const cap = captureFiles(
        list.candidates,
        (c, st) => (list.git?.tracked.has(c.rel) ? list.git.executable.has(c.rel) : process.platform !== 'win32' && (st.mode & 0o111) !== 0),
        opts.mode === 'full' ? (c, data, x) => writer.addPayload(c.archivePath, data, x) : null,
        (rel) => opts.hooks?.afterFile?.(rel, attempt),
      );
      const again = listCandidates(root, listOpts(opts));
      const before = new Set(list.candidates.map((c) => c.rel));
      const unstable = [...cap.unstable, ...again.candidates.filter((c) => !before.has(c.rel)).map((c) => c.rel)];
      if ((again.git?.info.head ?? null) !== headBefore) unstable.push('(git HEAD moved: a commit or checkout happened during capture)');
      if (unstable.length) {
        writer.abort();
        logEvent('pack.unstable', { attempt, files: unstable.length });
        if (attempt >= retries) throw new CaptureUnstableError(unstable);
        await delay(opts.retryDelayMs ?? 500 * attempt);
        continue;
      }

      // Files index, with the committed version as the base for safe updates.
      const git = list.git;
      const byArchive = new Map(list.candidates.map((c) => [c.archivePath, c.rel]));
      const statusOf = (rel: string) => (git ? fileStatus(git.status.get(rel)) : 'unknown');
      const needBase = git ? [...cap.files.map((f) => byArchive.get(f.path) as string).filter((r) => statusOf(r) === 'modified'), ...git.deleted] : [];
      const bases = git ? headVersions(root, git, needBase) : new Map();
      const entries: FileEntry[] = cap.files.map((f) => {
        const rel = byArchive.get(f.path) as string;
        const status = statusOf(rel);
        const base = status === 'unchanged' ? { sha256: f.sha256, normSha256: f.normSha256 } : status === 'modified' ? bases.get(rel) ?? null : null;
        return { ...f, status, baseSha256: base?.sha256 ?? null, baseNormSha256: base?.normSha256 ?? null, inPayload: opts.mode === 'full' };
      });
      const deletions = (git?.deleted ?? [])
        .filter((p) => bases.has(p))
        .map((p) => ({ path: p.normalize('NFC'), baseSha256: bases.get(p).sha256 as string, baseNormSha256: bases.get(p).normSha256 as string | null }));
      const paths = entries.map((e) => e.path);
      const files: FilesIndex = {
        entries,
        deletions,
        excluded: list.excluded,
        skipped: list.skipped,
        platformIssues: [...platformIssues(paths, 'win32'), ...platformIssues(paths, 'darwin'), ...platformIssues(paths, 'linux')],
      };

      const capsuleId = randomUUID();
      const createdAt = new Date().toISOString();
      const fp = fingerprint(entries);
      const sourceLabel = `${ctx.tool === 'manual' ? 'manual handoff' : ctx.tool}${ctx.surface !== 'unknown' ? ` (${ctx.surface})` : ''}${ctx.conversation.origin.title ? `, “${ctx.conversation.origin.title}”` : ''}`;

      const handoffBase: HandoffObject = ctx.handoffIn
        ? redactDeep(ctx.handoffIn)
        : {
            kind: HANDOFF_KIND,
            version: HANDOFF_VERSION,
            handoffId: randomUUID(),
            createdBy: { name: 'session-capsule', version: ENGINE_VERSION },
            capturedAt: createdAt,
            source: { tool: ctx.tool, surface: handoffSurface(ctx.tool, ctx.surface), platform: process.platform, toolVersion: ctx.toolVersion, model: null },
            session: { originalId: ctx.session?.id ?? null, originalRef: null, sourceProjectPath: root, firstRecordedAt: null, lastRecordedAt: ctx.session?.updatedAt ?? null },
            events: null,
            checkpoint: null,
            sourceStatusAtCapture: null,
            coverage: { history: ctx.conversation.completeness, truncation: ctx.conversation.notes.slice(0, 50), missing: ['Hidden reasoning, unsaved editor state, running processes and unfinished streamed messages are never captured.'] },
            notes: ctx.userNote ? redactSecrets(ctx.userNote).text : null,
          capsule: null,
          };
      const handoff: HandoffObject = {
        ...handoffBase,
        capsule: {
          id: capsuleId,
          formatVersion: FORMAT_VERSION,
          mode: opts.mode,
          createdAt,
          encrypted: !!opts.passphrase,
          fingerprint: fp,
          files: entries.map((e) => ({ path: e.path, sha256: e.sha256, size: e.size, status: e.status })),
          deletions: deletions.map((d) => d.path),
        },
      };

      const continuation = buildContinuation({ capsuleId, createdAt, mode: opts.mode, sourceLabel, userNote: ctx.userNote, git: git?.info ?? null, files, conversation: ctx.conversation, handoff });
      const environment = detectEnvironment(
        root,
        [{ name: ctx.tool, version: ctx.toolVersion, note: ctx.surface !== 'unknown' ? `surface: ${ctx.surface}` : null }],
        list.excluded.filter((e) => e.rule.startsWith('credential')).map((e) => e.path),
      );

      writer.addMeta('files.json', JSON.stringify(files, null, 1));
      writer.addMeta('conversation.json', JSON.stringify(ctx.conversation, null, 1));
      writer.addMeta('conversation.md', renderConversationMarkdown(ctx.conversation));
      writer.addMeta('continuation.md', continuation.markdown);
      writer.addMeta('environment.json', JSON.stringify(environment, null, 1));
      writer.addMeta('handoff.json', JSON.stringify(handoff, null, 1));
      const manifest = writer.finish({
        format: FORMAT_NAME,
        formatVersion: FORMAT_VERSION,
        capsuleId,
        createdAt,
        createdBy: `session-capsule ${ENGINE_VERSION}`,
        mode: opts.mode,
        tool: { id: ctx.tool, surface: ctx.surface, version: ctx.toolVersion },
        source: { platform: process.platform, arch: process.arch },
        project: { name: path.basename(root).slice(0, 255), git: git?.info ?? null, fingerprint: fp, fileCount: entries.length, totalBytes: entries.reduce((n, e) => n + e.size, 0) },
        conversation: {
          completeness: ctx.conversation.completeness,
          sessionId: ctx.conversation.origin.sessionId,
          title: ctx.conversation.origin.title?.slice(0, 500) ?? null,
          messageCount: ctx.conversation.messages.length,
          redactions: ctx.redactions,
        },
        restoration: { native: 'unsupported', note: 'The destination starts a new session that receives this context. No native session restore is verified for any supported tool.' },
      });
      finalizeCapsule(tmp, out, opts.passphrase ?? null, opts.scryptN ?? DEFAULT_SCRYPT_N);
      logEvent('pack.done', { capsuleId, mode: opts.mode, tool: ctx.tool, files: entries.length, deletions: deletions.length, messages: ctx.conversation.messages.length, redactions: ctx.redactions, encrypted: !!opts.passphrase, attempts: attempt });
      return { file: out, manifest, files, attempts: attempt, missingNoteSections: continuation.missingSections, warnings: ctx.warnings };
    } catch (err) {
      writer.abort();
      fs.rmSync(tmp, { force: true });
      throw err;
    }
  }
}

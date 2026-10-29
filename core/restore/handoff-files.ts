// Writes the readable handoff into <dest>/.session-capsule/<capsule-id>/ so the
// next agent (and Blocker's imported store) can read it on the destination,
// with no access to the source computer. The folder ignores itself in git.

import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, writeJsonAtomic } from '../common/fsx.ts';
import { renderConversationMarkdown } from '../handoff/conversation.ts';
import { renderEnvironmentMarkdown } from '../handoff/environment.ts';
import { handoffMessage } from '../handoff/message.ts';
import type { OpenedCapsule } from '../archive/capsule.ts';
import type { ContextReport } from './plan.ts';

export const HANDOFF_FOLDER = '.session-capsule';

export interface ImportRecord {
  kind: 'session-capsule.import';
  version: '1.0';
  capsuleId: string;
  importedAt: string;
  destinationRoot: string;
  mode: 'full' | 'context-only';
  importId: string | null;
  filesApplied: boolean;
  contextCheck: ContextReport | null;
  sourceStatus: 'historical-only';
}

export function handoffDir(dest: string, capsuleId: string): string {
  return path.join(dest, HANDOFF_FOLDER, capsuleId);
}

function safeDir(dest: string, capsuleId: string): string {
  const base = path.join(dest, HANDOFF_FOLDER);
  for (const p of [base, path.join(base, capsuleId)]) {
    const st = fs.lstatSync(p, { throwIfNoEntry: false });
    if (st && (st.isSymbolicLink() || !st.isDirectory())) throw new Error(`${p} is not a plain folder; refusing to write handoff files there.`);
    if (!st) fs.mkdirSync(p);
  }
  const ignore = path.join(base, '.gitignore');
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
  return path.join(base, capsuleId);
}

export function writeHandoffFiles(c: OpenedCapsule, dest: string, record: Omit<ImportRecord, 'kind' | 'version' | 'capsuleId' | 'importedAt' | 'destinationRoot' | 'mode' | 'sourceStatus'>): { dir: string; message: string } {
  const destRoot = path.resolve(dest);
  const dir = safeDir(destRoot, c.manifest.capsuleId);
  const rel = `${HANDOFF_FOLDER}/${c.manifest.capsuleId}`;
  const projectSummary = c.manifest.mode === 'context-only'
    ? record.contextCheck?.explanation.join(' ') ?? 'Files were not transferred.'
    : record.filesApplied
      ? 'The capsule’s file changes were applied to this folder after review. Unrelated files were left as they were.'
      : 'The capsule’s files have not been applied yet.';
  const message = handoffMessage({ manifest: c.manifest, handoffDir: rel, projectSummary, hasRecorderCheckpoint: !!c.handoff.checkpoint, envSteps: c.environment.steps.filter((s) => s.command).length });

  writeFileAtomic(path.join(dir, 'continuation.md'), c.continuation);
  writeFileAtomic(path.join(dir, 'conversation.md'), c.conversationMd ?? renderConversationMarkdown(c.conversation));
  writeFileAtomic(path.join(dir, 'environment.md'), renderEnvironmentMarkdown(c.environment));
  writeJsonAtomic(path.join(dir, 'handoff.json'), c.handoff);
  const full: ImportRecord = {
    kind: 'session-capsule.import',
    version: '1.0',
    capsuleId: c.manifest.capsuleId,
    importedAt: new Date().toISOString(),
    destinationRoot: destRoot,
    mode: c.manifest.mode,
    sourceStatus: 'historical-only',
    ...record,
  };
  writeJsonAtomic(path.join(dir, 'import.json'), full);
  writeFileAtomic(path.join(dir, 'message.txt'), message + '\n');
  return { dir, message };
}

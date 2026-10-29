#!/usr/bin/env node
// Session Capsule command line. Every command that changes files previews first
// and needs an explicit flag (or a "yes" at the prompt) to go ahead.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { ADAPTERS, CaptureUnstableError, pack, reviewPack, type PackOptions } from '../../core/pack.ts';
import { CapsuleError, openCapsule, type OpenedCapsule } from '../../core/archive/capsule.ts';
import { contextReport, planImport, type ImportPlan } from '../../core/restore/plan.ts';
import { applyImport, removeBackups, resumeImport, rollbackImport, UnresolvedError, type Decision, type Decisions } from '../../core/restore/apply.ts';
import { INTERRUPTED, listImports, loadJournal } from '../../core/restore/journal.ts';
import { writeHandoffFiles } from '../../core/restore/handoff-files.ts';
import { noteRequestPrompt } from '../../core/handoff/continuation.ts';
import { COMPLETENESS_TEXT } from '../../core/handoff/conversation.ts';
import { inert, inertLine } from '../../core/common/sanitize.ts';
import { appHome } from '../../core/common/appdata.ts';
import { ENGINE_VERSION, type CaptureMode, type Platform, type ToolId } from '../../core/common/types.ts';
import { confirm, interactive, passphrase } from './prompt.ts';

const out = (s = '') => process.stdout.write(s + '\n');
const line = (s: string) => out(inertLine(s, 300));
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KiB` : `${(n / 1048576).toFixed(1)} MiB`);

const HELP = `Session Capsule ${ENGINE_VERSION}: move an unfinished coding task to another computer.

Source computer
  capsule sessions --tool claude-code|codex [--project DIR]
  capsule note-prompt                        Prompt that asks your agent to write a continuation note
  capsule pack --project DIR [--tool claude-code|codex|manual] [--session ID|latest]
               [--handoff FILE]               Handoff object exported by Blocker (desktop-continuity)
               [--transcript FILE] [--note FILE] [--mode full|context]
               [--include GLOB]... [--exclude GLOB]... [--max-file-size MB] [--full-tool-output]
               [--encrypt [--passphrase-file FILE]] [--out FILE] [--dry-run] [--yes]

Destination computer
  capsule inspect CAPSULE [--conversation] [--files] [--note]
  capsule import CAPSULE --dest DIR          Preview only; nothing is written
               [--apply] [--on-conflict incoming|keep|both] [--take PATH]... [--keep PATH]... [--both PATH]...
               [--deletions apply|skip] [--skip PATH]... [--yes]
  capsule handoff CAPSULE --dest DIR [--copy]
  capsule recover | rollback IMPORT_ID [--force] | resume IMPORT_ID
  capsule backups [list | remove IMPORT_ID]
  capsule doctor

Encrypted capsules read the passphrase from --passphrase-file, CAPSULE_PASSPHRASE, or a prompt.`;

async function openWithPassphrase(file: string, passFile?: string): Promise<OpenedCapsule> {
  try {
    return openCapsule(file);
  } catch (err) {
    if (!(err instanceof CapsuleError) || err.code !== 'passphrase-required') throw err;
    const pass = await passphrase({ file: passFile, purpose: 'open this capsule' });
    if (!pass) throw err;
    return openCapsule(file, { passphrase: pass });
  }
}

async function cmdSessions(a: string[]): Promise<number> {
  const { values } = parseArgs({ args: a, options: { tool: { type: 'string' }, project: { type: 'string', default: process.cwd() } } });
  const adapter = ADAPTERS[values.tool ?? ''];
  if (!adapter) throw new Error('Pass --tool claude-code or --tool codex.');
  const sessions = adapter.listSessions(path.resolve(values.project as string));
  if (!sessions.length) out(`No ${adapter.label} sessions found for ${values.project}.`);
  for (const s of sessions) line(`${s.id}  ${s.updatedAt ?? ''}  ${s.surface}  ${s.title ?? '(untitled)'}`);
  return 0;
}

function printReview(r: ReturnType<typeof reviewPack>): void {
  out(`Project: ${inertLine(r.projectRoot)}`);
  out(`Mode: ${r.mode === 'full' ? 'full capsule (context + files)' : 'context only (files fingerprinted, not copied)'}`);
  if (r.git) out(`Git: ${r.git.info.branch ?? '(detached)'} @ ${r.git.info.head?.slice(0, 12) ?? '(no commits)'}${r.git.info.dirty ? ', uncommitted changes' : ''}`);
  else out('Git: not a repository (no base versions, no deletions recorded)');
  out(`\nFiles to ${r.mode === 'full' ? 'include' : 'fingerprint'}: ${r.included.length} (${size(r.totalBytes)})`);
  for (const f of r.included.slice(0, 40)) line(`  + ${f.path}  ${size(f.size)}`);
  if (r.included.length > 40) out(`  … ${r.included.length - 40} more`);
  if (r.deletions.length) {
    out(`Deleted since the last commit (recorded with their committed version): ${r.deletions.length}`);
    for (const d of r.deletions.slice(0, 20)) line(`  - ${d}`);
  }
  if (r.excluded.length) {
    out(`Excluded: ${r.excluded.length}`);
    for (const e of r.excluded.slice(0, 30)) line(`  x ${e.path}  (${e.rule})`);
  }
  for (const s of r.skipped.slice(0, 20)) line(`  ! skipped ${s.path}: ${s.reason}`);
  for (const i of r.platformIssues.slice(0, 20)) line(`  ! ${i.platform}: ${i.path}: ${i.detail}`);
  if (r.fileSecretFindings.length) {
    out('Possible secrets inside included files (values not shown). Exclude these files or remove the secrets:');
    for (const f of r.fileSecretFindings.slice(0, 20)) line(`  ! ${f.path}:${f.line}  ${f.type}`);
  }
  const c = r.conversation;
  out(`\nConversation: ${c.messages.length} messages from ${inertLine(c.origin.extractedFrom)}`);
  out(`  ${COMPLETENESS_TEXT[c.completeness]}`);
  if (r.session) line(`  Session ${r.session.id} (${r.session.surface}) ${r.session.title ?? ''}`);
  for (const n of c.notes) line(`  - ${n}`);
  if (r.redactions) out(`  ${r.redactions} likely secrets will be redacted from the conversation (best effort).`);
  if (r.recorderCheckpoint) out('  Includes the recorder checkpoint (observed facts, agent notes, inferences, missing context).');
  out(`\nContinuation note: ${r.noteSupplied ? 'supplied' : 'not supplied'}${r.missingNoteSections.length ? `; missing sections: ${r.missingNoteSections.join(', ')} (they will be marked "not recorded")` : ''}`);
  if (!r.noteSupplied) out('  Tip: run `capsule note-prompt`, paste it into your agent, and pass the saved file with --note.');
  for (const w of r.warnings) line(`Warning: ${w}`);
}

async function cmdPack(a: string[]): Promise<number> {
  const { values } = parseArgs({
    args: a,
    options: {
      project: { type: 'string', default: process.cwd() },
      tool: { type: 'string' },
      session: { type: 'string' },
      handoff: { type: 'string' },
      transcript: { type: 'string' },
      note: { type: 'string' },
      mode: { type: 'string', default: 'full' },
      include: { type: 'string', multiple: true, default: [] },
      exclude: { type: 'string', multiple: true, default: [] },
      'max-file-size': { type: 'string' },
      'full-tool-output': { type: 'boolean', default: false },
      encrypt: { type: 'boolean', default: false },
      'passphrase-file': { type: 'string' },
      out: { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
  });
  const mode: CaptureMode = values.mode === 'context' || values.mode === 'context-only' ? 'context-only' : values.mode === 'full' ? 'full' : (() => { throw new Error('--mode must be full or context'); })();
  if (values.tool && !['claude-code', 'codex', 'manual'].includes(values.tool)) throw new Error('--tool must be claude-code, codex or manual.');
  const root = path.resolve(values.project as string);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 13).replace('T', '-');
  const opts: PackOptions = {
    projectRoot: root,
    mode,
    tool: values.tool as ToolId | undefined,
    session: values.session ?? null,
    handoffPath: values.handoff ?? null,
    transcriptPath: values.transcript ?? null,
    notePath: values.note ?? null,
    include: values.include as string[],
    exclude: values.exclude as string[],
    maxFileSize: values['max-file-size'] ? Number(values['max-file-size']) * 1048576 : undefined,
    fullToolOutput: values['full-tool-output'],
    out: path.resolve(values.out ?? `${path.basename(root)}-${stamp}.capsule`),
  };
  printReview(reviewPack(opts));
  if (values['dry-run']) {
    out('\nDry run: nothing was written.');
    return 0;
  }
  out('\nBefore packing, stop or pause the coding agent so nothing changes during capture.');
  if (!values.yes) {
    if (!interactive()) throw new Error('Review the list above, then rerun with --yes to create the capsule.');
    if (!(await confirm(`Create ${opts.out}?`))) return 1;
  }
  if (values.encrypt) {
    opts.passphrase = await passphrase({ file: values['passphrase-file'], confirmTwice: true, purpose: 'encrypt this capsule' });
    if (!opts.passphrase) throw new Error('--encrypt needs a passphrase: use --passphrase-file or CAPSULE_PASSPHRASE when not running interactively.');
  }
  try {
    const r = await pack(opts);
    out(`\nCreated ${r.file} (${size(fs.statSync(r.file).size)}), capsule ${r.manifest.capsuleId}`);
    out(opts.passphrase ? 'Encrypted with your passphrase. Send the passphrase separately from the file.' : 'NOT encrypted: anyone who gets this file can read the conversation and project files in it. Use --encrypt for shared drives or email.');
    if (r.attempts > 1) out(`Files changed during capture; succeeded on attempt ${r.attempts}.`);
    out('Move it to the other computer however you like, then run: capsule import <file> --dest <folder>');
    return 0;
  } catch (err) {
    if (err instanceof CaptureUnstableError) {
      out(err.message);
      return 3;
    }
    throw err;
  }
}

async function cmdInspect(a: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: a, allowPositionals: true, options: { conversation: { type: 'boolean', default: false }, files: { type: 'boolean', default: false }, note: { type: 'boolean', default: false }, 'passphrase-file': { type: 'string' } } });
  const c = await openWithPassphrase(positionals[0] ?? '', values['passphrase-file']);
  try {
    const m = c.manifest;
    out(`Capsule ${m.capsuleId} (format ${m.formatVersion}), verified`);
    out(`Encryption: ${c.encrypted ? 'passphrase (AES-256-GCM)' : 'none: anyone with the file can read it'}`);
    out(`Created ${m.createdAt} on ${m.source.platform}/${m.source.arch} by ${m.createdBy}`);
    line(`Tool: ${m.tool.id} (${m.tool.surface}${m.tool.version ? `, ${m.tool.version}` : ''})`);
    out(`Mode: ${m.mode}; ${m.project.fileCount} files, ${size(m.project.totalBytes)}; ${c.files.deletions.length} deletions`);
    if (m.project.git) line(`Git: ${m.project.git.branch ?? '(detached)'} @ ${m.project.git.head?.slice(0, 12) ?? '-'}`);
    out(`Conversation: ${m.conversation.messageCount} messages; ${COMPLETENESS_TEXT[m.conversation.completeness]}`);
    out(`Session restore: not supported. The destination starts a new session that receives this context.`);
    if (c.handoff.sourceStatusAtCapture) out(`Source status: historical, observed ${c.handoff.sourceStatusAtCapture.observedAt}${c.handoff.sourceStatusAtCapture.exportForced ? ' (export was FORCED while the source may have been working)' : ''}. Current source activity: unknown.`);
    if (values.files) for (const f of c.files.entries) line(`  ${f.status.padEnd(9)} ${f.path}  ${size(f.size)}`);
    if (values.note) out('\n' + inert(c.continuation));
    if (values.conversation) out('\n' + inert(c.conversationMd ?? ''));
    return 0;
  } finally {
    c.close();
  }
}

function printPlan(plan: ImportPlan): void {
  const n = plan.counts;
  out(`Destination: ${inertLine(plan.dest)} (${plan.platform})`);
  const p = plan.project;
  if (p.sameCommit === true) out(`Git: same commit as the source (${p.destHead?.slice(0, 12)}).`);
  else if (p.sameCommit === false) out(`Git: this folder is on ${p.destHead?.slice(0, 12)}, the source was on ${p.sourceHead?.slice(0, 12)}.`);
  else if (p.sourceHead && !p.destIsGit) out('Git: the source was a repository; this folder is not.');
  if (plan.previousImports.length) out(`This capsule was imported here before (${plan.previousImports.map((i) => `${i.importId.slice(0, 8)} ${i.state}`).join(', ')}).`);
  out(`New ${n.create}, update ${n.update}, unchanged ${n.unchanged}, conflicts ${n.conflict}, delete ${n.delete}, delete conflicts ${n['delete-conflict']}, already deleted ${n['already-deleted']}, blocked ${n.blocked}`);
  for (const op of plan.ops) {
    if (op.kind === 'unchanged' && !op.note) continue;
    if (op.kind === 'already-deleted') continue;
    const detail = 'reason' in op ? `: ${op.reason}` : 'note' in op && op.note ? `: ${op.note}` : '';
    line(`  ${op.kind.padEnd(15)} ${op.path}${detail}`);
  }
  for (const w of plan.warnings) line(`  warning ${w.path}: ${w.detail}`);
}

async function cmdImport(a: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: a,
    allowPositionals: true,
    options: {
      dest: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'on-conflict': { type: 'string' },
      take: { type: 'string', multiple: true, default: [] },
      keep: { type: 'string', multiple: true, default: [] },
      both: { type: 'string', multiple: true, default: [] },
      deletions: { type: 'string' },
      skip: { type: 'string', multiple: true, default: [] },
      platform: { type: 'string' },
      yes: { type: 'boolean', default: false },
      'passphrase-file': { type: 'string' },
    },
  });
  if (!values.dest) throw new Error('Choose the destination folder with --dest.');
  const dest = path.resolve(values.dest);
  const c = await openWithPassphrase(positionals[0] ?? '', values['passphrase-file']);
  try {
    out(`Capsule ${c.manifest.capsuleId} verified (${c.encrypted ? 'encrypted' : 'not encrypted'}).`);
    const plan = planImport(c, dest, (values.platform as Platform | undefined) ?? undefined);
    printPlan(plan);

    if (c.manifest.mode === 'context-only') {
      const report = contextReport(c, plan);
      out('');
      for (const e of report.explanation) out(e);
      for (const p of report.missing.slice(0, 30)) line(`  missing   ${p}`);
      for (const p of report.different.slice(0, 30)) line(`  different ${p}`);
      if (!values.apply) return finishPreview('write the handoff files');
      const h = writeHandoffFiles(c, dest, { importId: null, filesApplied: false, contextCheck: report });
      return finishHandoff(h, c);
    }

    if (!values.apply) return finishPreview('apply these changes');
    const decisions: Decisions = {
      defaultConflict: values['on-conflict'] as Decision | undefined,
      deletions: values.deletions as 'apply' | 'skip' | undefined,
      skip: values.skip as string[],
      conflicts: Object.fromEntries([
        ...(values.take as string[]).map((p) => [p, 'incoming']),
        ...(values.keep as string[]).map((p) => [p, 'keep']),
        ...(values.both as string[]).map((p) => [p, 'both']),
      ]),
    };
    if (plan.counts.delete && !decisions.deletions) {
      out(`\n${plan.counts.delete} files were deleted on the source. Pass --deletions apply to delete them here (they are backed up first), or --deletions skip.`);
      return 2;
    }
    if (!values.yes) {
      if (!interactive()) throw new Error('Rerun with --yes to apply after reviewing the preview.');
      if (!(await confirm('Back up the affected files and apply?'))) return 1;
    }
    let result;
    try {
      result = applyImport(c, plan, decisions);
    } catch (err) {
      if (err instanceof UnresolvedError) {
        out(`\n${err.message} Nothing was changed.`);
        for (const p of err.paths.slice(0, 30)) line(`  ${p}`);
        out('Decide with --on-conflict incoming|keep|both, or per file with --take/--keep/--both PATH; skip blocked files with --skip PATH.');
        return 2;
      }
      throw err;
    }
    out(`\nApplied: ${result.written} written, ${result.deleted} deleted. Import ${result.importId}; backups kept until you remove them (capsule backups remove ${result.importId}).`);
    out(`Undo with: capsule rollback ${result.importId}`);
    return finishHandoff(writeHandoffFiles(c, dest, { importId: result.importId, filesApplied: true, contextCheck: null }), c);
  } finally {
    c.close();
  }
}

function finishPreview(what: string): number {
  out(`\nPreview only: nothing was written. Rerun with --apply to ${what}.`);
  return 0;
}

function finishHandoff(h: { dir: string; message: string }, c: OpenedCapsule): number {
  out(`\nHandoff files: ${h.dir}`);
  const steps = c.environment.steps;
  if (steps.length) {
    out('Environment steps to review (none were run):');
    steps.forEach((s, i) => line(`  ${i + 1}. ${s.title}${s.command ? `: ${s.command}` : ''}`));
  }
  out('\nOpen this folder in your coding tool, start a new session, and paste this message (also saved as message.txt):\n');
  out(inert(h.message));
  out('\nBlocker users: node <blocker>/src/capsule/imported-store.mjs register "' + h.dir + '" makes this context available to Claude Desktop over MCP.');
  return 0;
}

async function cmdHandoff(a: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: a, allowPositionals: true, options: { dest: { type: 'string' }, copy: { type: 'boolean', default: false }, 'passphrase-file': { type: 'string' } } });
  if (!values.dest) throw new Error('Pass --dest DIR.');
  const c = await openWithPassphrase(positionals[0] ?? '', values['passphrase-file']);
  try {
    const dest = path.resolve(values.dest);
    const ctx = c.manifest.mode === 'context-only' ? contextReport(c, planImport(c, dest)) : null;
    const h = writeHandoffFiles(c, dest, { importId: null, filesApplied: false, contextCheck: ctx });
    if (values.copy) await copyText(h.message);
    return finishHandoff(h, c);
  } finally {
    c.close();
  }
}

function copyText(text: string): Promise<void> {
  const tool = process.platform === 'darwin' ? 'pbcopy' : process.platform === 'win32' ? 'clip' : null;
  if (!tool) return Promise.resolve();
  return new Promise((resolve) => {
    const p = spawn(tool, [], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
    p.on('error', () => resolve());
    p.on('close', () => resolve());
    p.stdin.end(text);
  });
}

async function cmdRecover(): Promise<number> {
  const stuck = listImports().filter((i) => INTERRUPTED.includes(i.state));
  if (!stuck.length) {
    out('No interrupted imports.');
    return 0;
  }
  for (const i of stuck) {
    line(`${i.importId}  ${i.state}  ${i.dest}  (${i.actions} actions, ${i.createdAt})`);
    out(`  capsule rollback ${i.importId}    restore the files as they were before`);
    out(`  capsule resume ${i.importId}      finish applying from ${inertLine(loadJournal(i.importId).capsuleFile)}`);
  }
  return 0;
}

async function cmdRollback(a: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: a, allowPositionals: true, options: { force: { type: 'boolean', default: false } } });
  const r = rollbackImport(positionals[0] ?? '', { force: values.force });
  out(`Restored ${r.restored.length} files.`);
  if (r.keptModified.length) {
    out(`Kept ${r.keptModified.length} files that were changed after the import (rerun with --force to restore them anyway):`);
    for (const p of r.keptModified) line(`  ${p}`);
  }
  return 0;
}

async function cmdResume(a: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: a, allowPositionals: true, options: { 'passphrase-file': { type: 'string' } } });
  const j = loadJournal(positionals[0] ?? '');
  const c = await openWithPassphrase(j.capsuleFile, values['passphrase-file']);
  try {
    const r = resumeImport(j.importId, c);
    out(`Import ${r.importId} finished: ${r.written} written, ${r.deleted} deleted.`);
    return 0;
  } finally {
    c.close();
  }
}

async function cmdBackups(a: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args: a, allowPositionals: true, options: { force: { type: 'boolean', default: false } } });
  if (positionals[0] === 'remove') {
    removeBackups(positionals[1] ?? '', { force: values.force });
    out(`Removed import ${positionals[1]} and its backups.`);
    return 0;
  }
  const all = listImports();
  out(`Imports and backups in ${appHome()} (kept until you remove them):`);
  if (!all.length) out('  none');
  for (const i of all) line(`  ${i.importId}  ${i.state}  ${i.createdAt}  ${i.dest}`);
  return 0;
}

async function cmdDoctor(): Promise<number> {
  out(`Session Capsule ${ENGINE_VERSION} on Node ${process.version} (${process.platform}/${process.arch})`);
  out(`Data folder: ${appHome()}`);
  for (const ad of Object.values(ADAPTERS)) {
    out(`${ad.label}: history ${ad.capabilities.historyAccess}; native restore ${ad.capabilities.nativeRestore}; launch ${ad.capabilities.launch}`);
    for (const n of ad.capabilities.notes) out(`  ${n}`);
  }
  out('Blocker (desktop-continuity): handoff objects accepted with pack --handoff; see docs/blocker-integration.md.');
  return 0;
}

const COMMANDS: Record<string, (a: string[]) => Promise<number>> = {
  sessions: cmdSessions,
  'note-prompt': async () => (out(noteRequestPrompt()), 0),
  pack: cmdPack,
  inspect: cmdInspect,
  import: cmdImport,
  handoff: cmdHandoff,
  recover: cmdRecover,
  rollback: cmdRollback,
  resume: cmdResume,
  backups: cmdBackups,
  doctor: cmdDoctor,
};

const [cmd, ...rest] = process.argv.slice(2);
const run = COMMANDS[cmd ?? ''];
if (!run) {
  out(HELP);
  process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
}
try {
  process.exitCode = await run(rest);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  process.stderr.write(`capsule: ${inertLine(msg, 1000)}\n`);
  process.exitCode = err instanceof CapsuleError ? 3 : 1;
}

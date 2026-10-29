// Codex history adapter (Codex Desktop and CLI share ~/.codex/sessions).
// Record layout as observed in Codex 0.163; see docs/compatibility.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { samePath } from '../../core/common/fsx.ts';
import type { ActionType, ConversationDoc, Surface } from '../../core/common/types.ts';
import { MessageBuilder, obj, parseJsonLines, str, stringifyInput, type Adapter, type ExtractOptions, type SessionSummary } from '../types.ts';

function codexHome(): string {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function readRollout(file: string): Array<Record<string, unknown>> {
  let buf = fs.readFileSync(file);
  if (file.endsWith('.zst')) {
    if (typeof zlib.zstdDecompressSync !== 'function') throw new Error('Reading Codex Desktop sessions needs Node.js 22.15 or later (zstd support).');
    buf = zlib.zstdDecompressSync(buf);
  }
  return parseJsonLines(buf.toString('utf8'));
}

function* rolloutFiles(dir: string): Generator<string> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) yield* rolloutFiles(full);
    else if (e.isFile() && /^rollout-.*\.jsonl(\.zst)?$/.test(e.name)) yield full;
  }
}

function surfaceOf(originator: string | null): Surface {
  if (!originator) return 'unknown';
  if (/desktop/i.test(originator)) return 'desktop';
  if (/vscode|jetbrains|ide/i.test(originator)) return 'ide';
  if (/cli|exec|tui/i.test(originator)) return 'cli';
  return 'unknown';
}

function threadTitles(): Map<string, string> {
  const titles = new Map<string, string>();
  const file = path.join(codexHome(), 'session_index.jsonl');
  if (!fs.existsSync(file)) return titles;
  for (const r of parseJsonLines(fs.readFileSync(file, 'utf8'))) {
    if (str(r.id) && str(r.thread_name)) titles.set(str(r.id) as string, str(r.thread_name) as string);
  }
  return titles;
}

// Context Codex injects into user turns (environment, AGENTS.md, skills, app state).
function isInjectedContext(text: string): boolean {
  const t = text.trim();
  if (/^# AGENTS\.md instructions/i.test(t)) return true;
  const m = t.match(/^<([A-Za-z_][\w-]*)[^>]*>/);
  return !!m && t.endsWith(`</${m[1]}>`);
}

function commandFrom(args: Record<string, unknown> | null): string | null {
  const c = args?.command ?? args?.cmd;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return str(c);
}

function actionFor(name: string, input: unknown): { type: ActionType; summary: string } | null {
  const text = typeof input === 'string' ? input : '';
  let args = obj(input);
  if (!args && text.trim().startsWith('{')) {
    try {
      args = obj(JSON.parse(text));
    } catch {
      args = null;
    }
  }
  if (name === 'apply_patch') {
    const patch = text || str(args?.input) || '';
    const targets = [...patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1].trim());
    return { type: 'file-edit', summary: targets.length ? `apply_patch ${targets.join(', ')}` : 'apply_patch' };
  }
  if (['shell', 'exec_command', 'exec', 'local_shell', 'container.exec', 'unified_exec'].includes(name)) {
    const cmd = commandFrom(args) ?? (text || null);
    if (cmd) return { type: 'command', summary: cmd.split('\n').slice(0, 5).join('\n') };
  }
  if (name.startsWith('mcp__')) return { type: 'external', summary: name };
  return null;
}

function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  const o = obj(output);
  if (o) {
    if (typeof o.content === 'string') return o.content;
    if (typeof o.output === 'string') return o.output;
    if (Array.isArray(o.content)) return o.content.map((c) => str(obj(c)?.text) ?? '').join('\n');
  }
  if (Array.isArray(output)) return output.map((c) => str(obj(c)?.text) ?? '').join('\n');
  return stringifyInput(output);
}

export const codexAdapter: Adapter = {
  id: 'codex',
  label: 'Codex',
  capabilities: {
    historyAccess: 'verified',
    nativeRestore: 'unsupported',
    launch: 'manual',
    notes: ['History is read from ~/.codex/sessions. Paginated threads may be partial; Codex SQLite stores are not read.'],
  },

  listSessions(projectRoot: string): SessionSummary[] {
    const titles = threadTitles();
    const out: SessionSummary[] = [];
    for (const file of rolloutFiles(path.join(codexHome(), 'sessions'))) {
      let records: Array<Record<string, unknown>>;
      try {
        records = readRollout(file);
      } catch {
        continue;
      }
      const p = obj(records.find((r) => r.type === 'session_meta')?.payload);
      const cwd = str(p?.cwd);
      if (!p || !cwd || !samePath(cwd, projectRoot)) continue;
      if (obj(p.source)?.subagent) continue;
      const id = str(p.id) ?? str(p.session_id) ?? path.basename(file);
      const last = records.findLast((r) => str(r.timestamp));
      out.push({
        id,
        title: titles.get(id) ?? null,
        updatedAt: str(last?.timestamp) ?? fs.statSync(file).mtime.toISOString(),
        cwd,
        surface: surfaceOf(str(p.originator)),
        toolVersion: str(p.cli_version),
        file,
      });
    }
    return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  },

  extract(session: SessionSummary, opts: ExtractOptions): ConversationDoc {
    const b = new MessageBuilder();
    let developer = 0;
    let injected = 0;
    let reasoning = 0;
    let compacted = 0;
    let paginated = false;
    const callNames = new Map<string, string>();

    readRollout(session.file).forEach((r, i) => {
      const ts = str(r.timestamp);
      const p = obj(r.payload);
      const source = `codex:${str(p?.id) ?? str(p?.call_id) ?? `line-${i + 1}`}`;
      if (r.type === 'session_meta') {
        paginated = p?.history_mode === 'paginated';
        return;
      }
      if (r.type === 'compacted') {
        compacted++;
        b.push({ role: 'note', kind: 'text', timestamp: ts, text: 'Codex compacted the conversation here; only its summary of earlier turns remains in the session file.', source });
        return;
      }
      if (r.type !== 'response_item' || !p) return;
      const type = str(p.type) ?? '';

      if (type === 'message') {
        const role = str(p.role);
        const parts = Array.isArray(p.content) ? p.content.map((c) => str(obj(c)?.text) ?? '') : [];
        if (role === 'developer' || role === 'system') developer++;
        else if (role === 'user') {
          const kept = parts.filter((t) => {
            if (!isInjectedContext(t)) return t.trim().length > 0;
            injected++;
            return false;
          });
          if (kept.length) b.push({ role: 'user', kind: 'text', timestamp: ts, text: kept.join('\n\n').trim(), source });
        } else if (role === 'assistant') {
          const text = parts.join('\n\n').trim();
          if (text) b.push({ role: 'assistant', kind: 'text', timestamp: ts, text, source });
        }
        return;
      }
      if (type === 'reasoning') {
        reasoning++;
        return;
      }
      if (type.endsWith('_call_output')) {
        const name = callNames.get(str(p.call_id) ?? '') ?? null;
        b.push({ role: 'tool', kind: 'tool-result', timestamp: ts, toolName: name, text: outputText(p.output).trim(), source }, opts.maxToolOutput);
        return;
      }
      if (type.endsWith('_call')) {
        const name = str(p.name) ?? type.replace(/_call$/, '');
        const input = p.arguments ?? p.input ?? p.action ?? null;
        if (str(p.call_id)) callNames.set(str(p.call_id) as string, name);
        const action = type === 'local_shell_call' ? actionFor('local_shell', obj(p.action)) : actionFor(name, input);
        b.push({ role: 'assistant', kind: 'tool-call', timestamp: ts, toolName: name, action, text: stringifyInput(input), source }, opts.maxToolInput);
      }
    });

    const notes: string[] = [];
    if (developer) notes.push(`${developer} developer/system instruction messages were omitted.`);
    if (injected) notes.push(`${injected} blocks of context injected by Codex (environment, AGENTS.md, skills, app state) were omitted.`);
    if (reasoning) notes.push(`${reasoning} reasoning items were omitted.`);
    if (compacted) notes.push(`The conversation was compacted ${compacted} time(s); earlier turns are only available as Codex's summary.`);
    if (paginated) notes.push('Codex marks this thread as having paginated history. The session file may not contain every turn; check the preview before relying on it.');
    notes.push(`Tool output is limited to ${opts.maxToolOutput} characters per result; tool input to ${opts.maxToolInput}.`);

    return {
      origin: { tool: 'codex', surface: session.surface, sessionId: session.id, title: session.title, toolVersion: session.toolVersion, extractedFrom: 'Codex session file (~/.codex/sessions)' },
      completeness: paginated || compacted ? 'possibly-partial' : 'as-recorded',
      notes,
      messages: b.messages,
    };
  },
};

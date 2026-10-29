// Claude Code history adapter (desktop Code tab and CLI share one store).
// Record layout as observed in Claude Code 2.1.x; see docs/compatibility.md.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { samePath } from '../../core/common/fsx.ts';
import type { ActionType, ConversationDoc, Surface } from '../../core/common/types.ts';
import { MessageBuilder, obj, parseJsonLines, str, stringifyInput, type Adapter, type ExtractOptions, type SessionSummary } from '../types.ts';

function configDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

export function projectSlug(projectRoot: string): string {
  return path.resolve(projectRoot).replace(/[^a-zA-Z0-9]/g, '-');
}

function surfaceOf(entrypoint: string | null): Surface {
  if (entrypoint === 'claude-desktop') return 'desktop';
  if (entrypoint === 'cli') return 'cli';
  if (entrypoint && /vscode|jetbrains|ide/i.test(entrypoint)) return 'ide';
  return 'unknown';
}

function stripReminders(text: string): { text: string; removed: number } {
  let removed = 0;
  const out = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, () => {
    removed++;
    return '';
  });
  return { text: out, removed };
}

function firstCwd(file: string): string | null {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(512 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const rec of parseJsonLines(buf.subarray(0, n).toString('utf8'))) if (str(rec.cwd)) return str(rec.cwd);
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

function summarize(file: string): SessionSummary {
  let title: string | null = null;
  let firstPrompt: string | null = null;
  let cwd: string | null = null;
  let entrypoint: string | null = null;
  let version: string | null = null;
  let updatedAt: string | null = null;
  for (const r of parseJsonLines(fs.readFileSync(file, 'utf8'))) {
    if (r.type === 'custom-title' && str(r.customTitle)) title = str(r.customTitle);
    cwd ??= str(r.cwd);
    entrypoint ??= str(r.entrypoint);
    if (str(r.version)) version = str(r.version);
    if (str(r.timestamp)) updatedAt = str(r.timestamp);
    if (!firstPrompt && r.type === 'user' && !r.isSidechain && !r.isMeta) {
      const content = obj(r.message)?.content;
      const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => str(obj(c)?.text) ?? '').join(' ') : '';
      const cleaned = stripReminders(text).text.trim();
      if (cleaned) firstPrompt = cleaned.replace(/\s+/g, ' ').slice(0, 80);
    }
  }
  return {
    id: path.basename(file, '.jsonl'),
    title: title ?? firstPrompt,
    updatedAt: updatedAt ?? fs.statSync(file).mtime.toISOString(),
    cwd,
    surface: surfaceOf(entrypoint),
    toolVersion: version,
    file,
  };
}

function actionFor(name: string, input: Record<string, unknown> | null): { type: ActionType; summary: string } | null {
  if (name === 'Bash' && str(input?.command)) return { type: 'command', summary: str(input?.command) as string };
  if (['Edit', 'Write', 'MultiEdit', 'NotebookEdit'].includes(name)) {
    const target = str(input?.file_path) ?? str(input?.notebook_path);
    if (target) return { type: 'file-edit', summary: `${name} ${target}` };
  }
  if (name.startsWith('mcp__')) return { type: 'external', summary: name };
  return null;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      const o = obj(c);
      if (o?.type === 'text') return str(o.text) ?? '';
      if (o?.type === 'image') return '[image omitted]';
      return '';
    })
    .join('\n');
}

export const claudeCodeAdapter: Adapter = {
  id: 'claude-code',
  label: 'Claude Code',
  capabilities: {
    historyAccess: 'verified',
    nativeRestore: 'unsupported',
    launch: 'manual',
    notes: ['History is read from ~/.claude/projects. Thinking, sub-agent and harness-injected content is omitted.'],
  },

  listSessions(projectRoot: string): SessionSummary[] {
    const projectsDir = path.join(configDir(), 'projects');
    if (!fs.existsSync(projectsDir)) return [];
    const slugDir = path.join(projectsDir, projectSlug(projectRoot));
    const dirs = fs.existsSync(slugDir) ? [slugDir] : fs.readdirSync(projectsDir).map((d) => path.join(projectsDir, d));
    const out: SessionSummary[] = [];
    for (const dir of dirs) {
      let names: string[];
      try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const name of names) {
        const file = path.join(dir, name);
        const cwd = firstCwd(file);
        if (cwd ? !samePath(cwd, projectRoot) : dir !== slugDir) continue;
        out.push(summarize(file));
      }
    }
    return out.sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
  },

  extract(session: SessionSummary, opts: ExtractOptions): ConversationDoc {
    const b = new MessageBuilder();
    const seen = new Set<string>();
    let thinking = 0;
    let sidechain = 0;
    let reminders = 0;
    let compactions = 0;

    const userText = (text: string, ts: string | null, source: string) => {
      const s = stripReminders(text);
      reminders += s.removed;
      if (s.text.trim()) b.push({ role: 'user', kind: 'text', timestamp: ts, text: s.text.trim(), source });
    };

    for (const r of parseJsonLines(fs.readFileSync(session.file, 'utf8'))) {
      const uuid = str(r.uuid);
      if (uuid) {
        if (seen.has(uuid)) continue;
        seen.add(uuid);
      }
      const ts = str(r.timestamp);
      const source = `claude-code:${uuid ?? 'record'}`;
      if (r.type === 'system' && r.subtype === 'compact_boundary') {
        compactions++;
        b.push({ role: 'note', kind: 'text', timestamp: ts, text: 'Claude Code compacted the conversation here; earlier turns were summarized for the model.', source });
        continue;
      }
      if (r.type !== 'user' && r.type !== 'assistant') continue;
      if (r.isSidechain) {
        sidechain++;
        continue;
      }
      if (r.isMeta) continue;
      const content = obj(r.message)?.content;

      if (r.type === 'user') {
        if (typeof content === 'string') userText(content, ts, source);
        else if (Array.isArray(content)) {
          for (const c of content) {
            const block = obj(c);
            if (block?.type === 'text') userText(str(block.text) ?? '', ts, source);
            else if (block?.type === 'image') b.push({ role: 'user', kind: 'text', timestamp: ts, text: '[image omitted]', source });
            else if (block?.type === 'tool_result') {
              const s = stripReminders(toolResultText(block.content));
              reminders += s.removed;
              b.push({ role: 'tool', kind: 'tool-result', timestamp: ts, text: s.text.trim(), source }, opts.maxToolOutput);
            }
          }
        }
        continue;
      }

      if (!Array.isArray(content)) continue;
      for (const c of content) {
        const block = obj(c);
        if (block?.type === 'text' && str(block.text)?.trim()) {
          b.push({ role: 'assistant', kind: 'text', timestamp: ts, text: (str(block.text) as string).trim(), source });
        } else if (block?.type === 'tool_use') {
          const name = str(block.name) ?? 'tool';
          b.push(
            { role: 'assistant', kind: 'tool-call', timestamp: ts, toolName: name, action: actionFor(name, obj(block.input)), text: stringifyInput(block.input), source },
            opts.maxToolInput,
          );
        } else if (block?.type === 'thinking' || block?.type === 'redacted_thinking') thinking++;
      }
    }

    const notes: string[] = [];
    if (thinking) notes.push(`${thinking} thinking blocks were omitted.`);
    if (sidechain) notes.push(`${sidechain} sub-agent records were omitted; their results appear as tool results.`);
    if (reminders) notes.push(`${reminders} harness-injected system reminders were removed from messages.`);
    if (compactions) notes.push(`The conversation was compacted ${compactions} time(s); records before each compaction are included as written to the session file.`);
    notes.push(`Tool output is limited to ${opts.maxToolOutput} characters per result; tool input to ${opts.maxToolInput}.`);

    return {
      origin: {
        tool: 'claude-code',
        surface: session.surface,
        sessionId: session.id,
        title: session.title,
        toolVersion: session.toolVersion,
        extractedFrom: 'Claude Code session file (~/.claude/projects)',
      },
      completeness: 'as-recorded',
      notes,
      messages: b.messages,
    };
  },
};

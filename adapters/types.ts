import type { ActionType, ConversationDoc, ConversationMessage, Surface, ToolId } from '../core/common/types.ts';

export interface SessionSummary {
  id: string;
  title: string | null;
  updatedAt: string | null;
  cwd: string | null;
  surface: Surface;
  toolVersion: string | null;
  file: string;
}

export interface ExtractOptions {
  maxToolOutput: number;
  maxToolInput: number;
}

export const DEFAULT_EXTRACT: ExtractOptions = { maxToolOutput: 4000, maxToolInput: 2000 };

// Capability record per tool, kept in sync with docs/compatibility.md. Native
// restore stays 'unsupported' until a mechanism is verified on both platforms.
export interface Capabilities {
  historyAccess: 'verified' | 'user-supplied';
  nativeRestore: 'unsupported';
  launch: 'manual';
  notes: string[];
}

export interface Adapter {
  id: ToolId;
  label: string;
  capabilities: Capabilities;
  listSessions(projectRoot: string): SessionSummary[];
  extract(session: SessionSummary, opts: ExtractOptions): ConversationDoc;
}

// Accumulates messages with consistent numbering and truncation.
export class MessageBuilder {
  messages: ConversationMessage[] = [];

  push(
    m: Omit<ConversationMessage, 'index' | 'truncated' | 'action' | 'toolName'> & {
      toolName?: string | null;
      action?: { type: ActionType; summary: string } | null;
    },
    max?: number,
  ): void {
    let text = m.text;
    let truncated = false;
    if (max !== undefined && text.length > max) {
      truncated = true;
      text = `${text.slice(0, max)}\n[… ${text.length - max} more characters not included]`;
    }
    this.messages.push({
      index: this.messages.length,
      role: m.role,
      kind: m.kind,
      timestamp: m.timestamp,
      text,
      toolName: m.toolName ?? null,
      action: m.action ? { type: m.action.type, summary: m.action.summary.slice(0, 2000) } : null,
      truncated,
      source: m.source,
    });
  }
}

export function stringifyInput(input: unknown): string {
  if (typeof input === 'string') return input;
  try {
    return JSON.stringify(input, null, 2) ?? '';
  } catch {
    return String(input);
  }
}

export function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const v = JSON.parse(line);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      // Skip a partial line, e.g. one being written while we read.
    }
  }
  return out;
}

export function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function obj(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

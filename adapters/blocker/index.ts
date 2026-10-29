// Blocker (desktop-continuity) adapter. Blocker is the recorder; it exports a
// handoff object (its src/capsule/export.mjs). This adapter only reads that file:
// it never opens Blocker's store or the source transcript.

import fs from 'node:fs';
import { validateNamed } from '../../core/common/schema.ts';
import { HANDOFF_KIND, type ConversationDoc, type HandoffObject, type Surface } from '../../core/common/types.ts';
import { MessageBuilder, obj, str, stringifyInput, type ExtractOptions } from '../types.ts';

export function readHandoff(file: string): HandoffObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new Error(`${file} is not a JSON handoff object.`);
  }
  if (obj(parsed)?.kind !== HANDOFF_KIND) throw new Error(`${file} is not a ${HANDOFF_KIND} object.`);
  const errors = validateNamed('handoff', parsed);
  if (errors.length) throw new Error(`${file} does not match handoff format 1.x: ${errors.slice(0, 3).join('; ')}`);
  const h = parsed as HandoffObject;
  if (h.capsule) throw new Error(`${file} already belongs to capsule ${h.capsule.id}; export a fresh handoff from the recorder.`);
  return h;
}

export function capsuleSurface(h: HandoffObject): Surface {
  if (/desktop|cowork|chat/.test(h.source.surface)) return 'desktop';
  if (/cli/.test(h.source.surface)) return 'cli';
  if (/ide/.test(h.source.surface)) return 'ide';
  return 'unknown';
}

// Outcome wording follows Blocker's pairActions: a missing PostToolUse is UNKNOWN,
// and "result recorded" is never upgraded to success.
function outcomes(items: Array<Record<string, unknown>>): Map<string, string> {
  const results = new Map<string, string>();
  for (const e of items) if (e.event === 'PostToolUse' && str(e.toolUseId)) results.set(str(e.toolUseId) as string, 'result recorded (not proof of success)');
  return results;
}

function commandOf(input: unknown): string | null {
  const o = obj(input);
  if (typeof input === 'string') return input;
  const c = o?.command ?? o?.cmd;
  if (Array.isArray(c)) return c.map(String).join(' ');
  return str(c);
}

export function conversationFromHandoff(h: HandoffObject, opts: ExtractOptions): ConversationDoc {
  const items = h.events?.items ?? [];
  const recorded = outcomes(items);
  const b = new MessageBuilder();
  for (const e of items) {
    const seq = typeof e.seq === 'number' ? e.seq : null;
    const source = `blocker:${h.session.originalId ?? 'session'}#${seq ?? '?'}`;
    const ts = str(e.ts);
    switch (e.event) {
      case 'UserPromptSubmit':
        if (str(e.prompt)) b.push({ role: 'user', kind: 'text', timestamp: ts, text: str(e.prompt) as string, source });
        break;
      case 'PreToolUse': {
        const tool = str(e.tool) ?? 'tool';
        const id = str(e.toolUseId);
        const outcome = id && recorded.has(id) ? (recorded.get(id) as string) : 'UNKNOWN: no result was recorded; verify before repeating';
        const cmd = commandOf(e.input);
        const patchTargets = cmd ? [...cmd.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((m) => m[1].trim()) : [];
        const action = patchTargets.length
          ? { type: 'file-edit' as const, summary: `${tool} ${patchTargets.join(', ')} [${outcome}]` }
          : tool.startsWith('mcp__')
            ? { type: 'external' as const, summary: `${tool} [${outcome}]` }
            : cmd
              ? { type: 'command' as const, summary: `${cmd.split('\n').slice(0, 3).join('\n')} [${outcome}]` }
              : { type: 'other' as const, summary: `${tool} [${outcome}]` };
        b.push({ role: 'assistant', kind: 'tool-call', timestamp: ts, toolName: tool, action, text: stringifyInput(e.input), source }, opts.maxToolInput);
        break;
      }
      case 'PostToolUse':
        b.push({ role: 'tool', kind: 'tool-result', timestamp: ts, toolName: str(e.tool), text: stringifyInput(e.response ?? '(no output recorded)'), source }, opts.maxToolOutput);
        break;
      case 'Stop':
        if (str(e.lastAssistantMessage)) b.push({ role: 'assistant', kind: 'text', timestamp: ts, text: str(e.lastAssistantMessage) as string, source });
        b.push({ role: 'note', kind: 'text', timestamp: ts, text: 'The source reported the end of the turn (Stop hook). This does not prove the task is finished.', source });
        break;
      case 'Interrupt':
        b.push({ role: 'note', kind: 'text', timestamp: ts, text: 'The user interrupted the turn in the source app.', source });
        break;
      case 'SessionEnd':
        b.push({ role: 'note', kind: 'text', timestamp: ts, text: `The source session ended (${str(e.reason) ?? 'no reason given'}).`, source });
        break;
      default:
        break;
    }
  }
  const notes = [
    'Built from hook events recorded by Blocker (desktop-continuity). This is not the full transcript: assistant text appears only where a Stop hook carried the last message.',
    ...h.coverage.truncation,
  ];
  if (h.events && h.events.omittedBefore > 0) notes.push(`${h.events.omittedBefore} earlier recorded events were not included in the export.`);
  return {
    origin: {
      tool: h.source.tool,
      surface: capsuleSurface(h),
      sessionId: h.session.originalId,
      title: null,
      toolVersion: h.source.toolVersion,
      extractedFrom: `Handoff object from ${h.createdBy.name} ${h.createdBy.version}`,
    },
    completeness: items.length ? 'possibly-partial' : 'unavailable',
    notes,
    messages: b.messages,
  };
}

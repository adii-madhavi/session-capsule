// Manual handoff: a transcript the user supplies, or no history at all.
// Supplied text is kept as given and labelled user-supplied; nothing is inferred.

import fs from 'node:fs';
import path from 'node:path';
import { validateNamed } from '../../core/common/schema.ts';
import type { ConversationDoc, Surface, ToolId } from '../../core/common/types.ts';
import { MessageBuilder, obj, str } from '../types.ts';

export function fromTranscript(file: string, tool: ToolId = 'manual', surface: Surface = 'unknown'): ConversationDoc {
  const raw = fs.readFileSync(file, 'utf8');
  const name = path.basename(file);
  const origin = { tool, surface, sessionId: null, title: null, toolVersion: null, extractedFrom: `User-supplied transcript (${name})` };

  if (/\.json$/i.test(file)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    if (parsed && validateNamed('conversation', parsed).length === 0) {
      const doc = parsed as ConversationDoc;
      return { ...doc, origin: { ...doc.origin, extractedFrom: `User-supplied conversation archive (${name})` }, completeness: 'user-supplied' };
    }
    if (Array.isArray(parsed)) {
      const b = new MessageBuilder();
      for (const item of parsed) {
        const o = obj(item);
        const role = str(o?.role);
        const content = o?.content;
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.map((c) => str(obj(c)?.text) ?? '').join('\n') : '';
        if (!text.trim()) continue;
        b.push({ role: role === 'assistant' ? 'assistant' : role === 'user' ? 'user' : 'note', kind: 'text', timestamp: str(o?.timestamp), text, source: `user-supplied:${name}` });
      }
      return { origin, completeness: 'user-supplied', notes: ['Messages were read from a user-supplied JSON list.'], messages: b.messages };
    }
  }

  const b = new MessageBuilder();
  b.push({ role: 'note', kind: 'text', timestamp: null, text: raw, source: `user-supplied:${name}` });
  return { origin, completeness: 'user-supplied', notes: ['The transcript was supplied as plain text and is kept as one block.'], messages: b.messages };
}

export function noHistory(tool: ToolId, surface: Surface, reason: string): ConversationDoc {
  return {
    origin: { tool, surface, sessionId: null, title: null, toolVersion: null, extractedFrom: 'none' },
    completeness: 'unavailable',
    notes: [reason],
    messages: [],
  };
}

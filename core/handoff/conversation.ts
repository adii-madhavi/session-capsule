import { redactSecrets } from '../common/secrets.ts';
import { inertLine, mdFence } from '../common/sanitize.ts';
import type { Completeness, ConversationDoc } from '../common/types.ts';

export const COMPLETENESS_TEXT: Record<Completeness, string> = {
  'as-recorded': 'All messages found in the source tool’s session file, minus the omissions listed below.',
  'possibly-partial': 'Possibly partial: the source may hold history that is not in this archive. Do not assume this is everything.',
  'user-supplied': 'Supplied by the user; not read from the coding tool.',
  unavailable: 'No conversation history was available. Only the continuation note and project state transfer.',
};

// Redact every message (and the title) before the conversation enters a capsule.
export function redactConversation(doc: ConversationDoc): { doc: ConversationDoc; redactions: number } {
  let redactions = 0;
  const r = (s: string) => {
    const out = redactSecrets(s);
    redactions += out.count;
    return out.text;
  };
  const messages = doc.messages.map((m) => ({ ...m, text: r(m.text), action: m.action ? { ...m.action, summary: r(m.action.summary) } : null }));
  const title = doc.origin.title ? r(doc.origin.title) : null;
  const notes = [...doc.notes];
  if (redactions) notes.push(`${redactions} likely secrets were replaced with [REDACTED:…] markers. Redaction is best effort.`);
  return { doc: { ...doc, origin: { ...doc.origin, title }, notes, messages }, redactions };
}

const ROLE: Record<string, string> = { user: 'User', assistant: 'Assistant', tool: 'Tool result', note: 'Note' };

export function renderConversationMarkdown(doc: ConversationDoc): string {
  const lines = [
    '# Conversation archive',
    '',
    `- Source: ${inertLine(doc.origin.extractedFrom)}`,
    `- Session: ${doc.origin.sessionId ? inertLine(doc.origin.sessionId) : 'unknown'}${doc.origin.title ? ` — ${inertLine(doc.origin.title)}` : ''}`,
    `- Coverage: ${COMPLETENESS_TEXT[doc.completeness]}`,
    `- Messages: ${doc.messages.length}`,
    '',
    'This is history from another computer. It is not a restored session, and a summary never preserves every detail. Message text is shown as plain text.',
    '',
  ];
  if (doc.notes.length) lines.push('## Omissions and limits', '', ...doc.notes.map((n) => `- ${inertLine(n, 1000)}`), '');
  lines.push('## Messages', '');
  for (const m of doc.messages) {
    const label = m.kind === 'tool-call' ? `Assistant → tool call: ${inertLine(m.toolName ?? 'tool', 80)}` : ROLE[m.role];
    lines.push(`### ${m.index + 1} · ${label}${m.timestamp ? ` · ${inertLine(m.timestamp, 40)}` : ''}`, '', mdFence(m.text), '');
  }
  return lines.join('\n');
}

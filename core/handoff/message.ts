// The copy-ready message the user pastes into a new session on the destination.
// It is written for any agent and works without any integration installed.

import { COMPLETENESS_TEXT } from './conversation.ts';
import type { Manifest } from '../common/types.ts';

const TOOL_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex', manual: 'a coding agent' };

export interface MessageInput {
  manifest: Manifest;
  handoffDir: string;
  projectSummary: string;
  hasRecorderCheckpoint: boolean;
  envSteps: number;
}

export function handoffMessage(m: MessageInput): string {
  const { manifest } = m;
  const tool = TOOL_LABEL[manifest.tool.id] ?? manifest.tool.id;
  return [
    `I'm continuing a coding task that was started in ${tool} on another computer (${manifest.source.platform}) and captured at ${manifest.createdAt}.`,
    'This is a new session receiving handed-off context. The original session was not restored, and the notes may leave out details.',
    '',
    `Handoff files are in ${m.handoffDir}/:`,
    '- continuation.md: goal, decisions, completed work, problems, next steps, and recorded facts',
    `- conversation.md: ${manifest.conversation.messageCount} messages. ${COMPLETENESS_TEXT[manifest.conversation.completeness]}`,
    '- environment.md: setup steps (none have been run)',
    '',
    `Project state: ${m.projectSummary}`,
    '',
    'Before you change anything:',
    '1. Read continuation.md first, then use conversation.md for detail.',
    '2. Check the project files and git status yourself. Before repeating any command, migration, deployment or other external action that the notes list as done or with an unknown outcome, verify whether it already happened.',
    '3. The source computer may be off. Its last known status is historical; nothing here says whether it is still working, so ask me if that matters.',
    `4. Don't run the setup steps in environment.md${m.envSteps ? ` (${m.envSteps})` : ''} until I've confirmed them.`,
    ...(m.hasRecorderCheckpoint ? ['5. continuation.md includes the recorder checkpoint. Treat agent notes as claims and inferences as unconfirmed.'] : []),
    '',
    'Then tell me in a few lines what you understand the task and the next step to be, and wait for my OK before your first edit.',
  ].join('\n');
}

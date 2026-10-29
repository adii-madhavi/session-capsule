// Imported conversation text is untrusted. These helpers make sure it is only
// ever shown as inert text: no terminal escape sequences, no live HTML or
// Markdown, no bidirectional-override tricks.

// CSI, OSC, DCS/PM/APC strings and lone escapes.
const ANSI = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[PX^_][^\u001b]*\u001b\\|[@-Z\\-_])/g;
const C1_AND_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;

export function inert(text: string): string {
  return text.replace(ANSI, '').replace(C1_AND_CONTROL, '').replace(BIDI, '').replace(/\r\n?/g, '\n');
}

export function inertLine(text: string, max = 200): string {
  const s = inert(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
}

// A fenced code block that the content can't break out of.
export function mdFence(text: string, info = 'text'): string {
  const body = inert(text);
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}${info}\n${body}${body.endsWith('\n') ? '' : '\n'}${fence}`;
}

export function mdInlineCode(text: string): string {
  const body = inertLine(text, 300);
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  const pad = body.startsWith('`') || body.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${body}${pad}${ticks}`;
}

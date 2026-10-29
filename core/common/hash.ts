import { createHash } from 'node:crypto';

export function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

// Text heuristic shared with git: a NUL byte in the first 8000 bytes means binary.
export function isText(data: Buffer): boolean {
  return !data.subarray(0, 8000).includes(0);
}

export function normalizeEol(data: Buffer): Buffer {
  if (!data.includes(13)) return data;
  return Buffer.from(data.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

// Hash of the content with CRLF line endings turned into LF; null for binary data.
export function normSha256(data: Buffer): string | null {
  return isText(data) ? sha256(normalizeEol(data)) : null;
}

export type EolStyle = 'lf' | 'crlf' | 'mixed' | 'none';

export function eolStyle(data: Buffer): EolStyle {
  const s = data.toString('latin1');
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/\n/g) ?? []).length;
  if (lf === 0) return 'none';
  if (crlf === lf) return 'crlf';
  if (crlf === 0) return 'lf';
  return 'mixed';
}

export function toCrlf(data: Buffer): Buffer {
  return Buffer.from(data.toString('latin1').replace(/\n/g, '\r\n'), 'latin1');
}

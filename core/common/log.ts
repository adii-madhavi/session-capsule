import fs from 'node:fs';
import path from 'node:path';
import { appDir } from './appdata.ts';

// Operational log. Only identifiers, counts and outcomes go here: never file
// contents, conversation text or continuation notes. Callers pass primitives only,
// and long strings are clipped so nothing bulky can slip in.
type Field = string | number | boolean | null;

export function logEvent(event: string, fields: Record<string, Field> = {}): void {
  const clipped: Record<string, Field> = {};
  for (const [k, v] of Object.entries(fields)) clipped[k] = typeof v === 'string' ? v.slice(0, 200) : v;
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...clipped });
  try {
    fs.appendFileSync(path.join(appDir('logs'), 'capsule.log'), line + '\n');
  } catch {
    // logging must never break an import or export
  }
}

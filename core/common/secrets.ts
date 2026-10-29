// High-confidence secret patterns. Used to redact conversation text and notes
// before they enter a capsule, and to warn about secrets inside included files.

interface Pattern {
  type: string;
  re: RegExp;
  // Index of the capture group holding the secret; 0 redacts the whole match.
  group: number;
}

const PATTERNS: Pattern[] = [
  { type: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, group: 0 },
  { type: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g, group: 0 },
  { type: 'openai-key', re: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g, group: 0 },
  { type: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/g, group: 0 },
  { type: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}/g, group: 0 },
  { type: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, group: 0 },
  { type: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g, group: 0 },
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g, group: 0 },
  { type: 'stripe-key', re: /\b[rs]k_live_[0-9A-Za-z]{20,}/g, group: 0 },
  { type: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g, group: 0 },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, group: 0 },
  { type: 'url-password', re: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:([^\s@/]{3,})@/gi, group: 1 },
  {
    type: 'assigned-secret',
    re: /\b[A-Za-z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|ACCESS_?KEY)[A-Za-z0-9_]*["']?\s*[:=]\s*["']?([^\s"'`,;]{8,})/gi,
    group: 1,
  },
];

// Values that name where a secret comes from rather than being one.
function isReference(value: string): boolean {
  if (/[()]/.test(value)) return true;
  return /^(?:process\.env|os\.environ|env\(|\$\{?|<|\{\{|getenv|secrets\.|ENV\[|import\.meta\.env|\*{3,}|x{6,}|\[REDACTED)/i.test(value);
}

export interface RedactionResult {
  text: string;
  count: number;
  types: string[];
}

export function redactSecrets(text: string): RedactionResult {
  let count = 0;
  const types = new Set<string>();
  let out = text;
  for (const p of PATTERNS) {
    out = out.replace(p.re, (match: string, ...groups: unknown[]) => {
      const secret = p.group === 0 ? match : (groups[p.group - 1] as string | undefined);
      if (!secret || (p.group !== 0 && isReference(secret))) return match;
      count++;
      types.add(p.type);
      const marker = `[REDACTED:${p.type}]`;
      return p.group === 0 ? marker : match.replace(secret, marker);
    });
  }
  return { text: out, count, types: [...types] };
}

export interface SecretFinding {
  line: number;
  type: string;
}

// Locations only. The matched value is never returned, so it can't leak into output.
export function findSecrets(text: string, maxFindings = 20): SecretFinding[] {
  const findings: SecretFinding[] = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      const secret = p.group === 0 ? m[0] : m[p.group];
      if (!secret || (p.group !== 0 && isReference(secret))) continue;
      const line = text.slice(0, m.index).split('\n').length;
      findings.push({ line, type: p.type });
      if (findings.length >= maxFindings) return findings;
    }
  }
  return findings.sort((a, b) => a.line - b.line);
}

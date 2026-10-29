import { matchAny } from '../common/glob.ts';

// Never captured, whatever the user includes.
export const ALWAYS_EXCLUDED = ['.git', '.session-capsule'];

export const DEPENDENCY_DIRS = [
  'node_modules', 'bower_components', '.pnpm-store', '.yarn/cache', '.venv', 'venv', '__pycache__',
  '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', 'Pods', '.dart_tool', '.gradle', '.terraform',
];

export const BUILD_DIRS = [
  'dist', 'build', 'out', 'target', '.next', '.nuxt', '.svelte-kit', '.turbo', '.parcel-cache', '.cache',
  'coverage', 'DerivedData', '.output', '.vercel',
];

export const OS_JUNK = ['.DS_Store', 'Thumbs.db', 'desktop.ini'];

export const CREDENTIALS = [
  '.env', '.env.*', '*.pem', '*.key', '*.p12', '*.pfx', '*.jks', '*.keystore', '*.kdbx',
  'id_rsa*', 'id_dsa*', 'id_ecdsa*', 'id_ed25519*', '.npmrc', '.pypirc', '.netrc', '_netrc',
  '.git-credentials', 'credentials.json', 'auth.json', 'service-account*.json', '*.tfstate', '*.tfstate.*',
  '.aws', '.ssh', '.gnupg', 'secrets.*',
];

// Templates and public keys look like credentials by name but are safe to move.
export const CREDENTIAL_EXCEPTIONS = ['.env.example', '.env.sample', '.env.template', '.env.defaults', '*.pub'];

export type ExclusionKind = 'always' | 'credential' | 'dependency' | 'build' | 'os' | 'user';

export interface ExclusionRules {
  include: string[];
  exclude: string[];
  // In a git project, tracked files in folders named like build output are kept:
  // they were committed on purpose. Untracked ones are excluded.
  tracked?: (relPath: string) => boolean;
}

export function classify(relPath: string, rules: ExclusionRules): { kind: ExclusionKind; rule: string } | null {
  const always = matchAny(ALWAYS_EXCLUDED, relPath);
  if (always) return { kind: 'always', rule: `never captured (${always})` };
  const user = matchAny(rules.exclude, relPath);
  if (user) return { kind: 'user', rule: `excluded by you (${user})` };
  if (matchAny(rules.include, relPath)) return null;
  const base = relPath.split('/').pop() as string;
  const cred = matchAny(CREDENTIALS, relPath);
  if (cred && !matchAny(CREDENTIAL_EXCEPTIONS, base)) return { kind: 'credential', rule: `credential (${cred})` };
  if (matchAny(OS_JUNK, relPath)) return { kind: 'os', rule: 'operating-system file' };
  if (rules.tracked?.(relPath)) return null;
  const dep = matchAny(DEPENDENCY_DIRS, relPath);
  if (dep) return { kind: 'dependency', rule: `dependency folder (${dep})` };
  const build = matchAny(BUILD_DIRS, relPath);
  if (build) return { kind: 'build', rule: `build output (${build})` };
  return null;
}

// The top-most folder responsible for an exclusion, so a whole node_modules is
// listed once instead of file by file.
export function exclusionRoot(relPath: string, rules: ExclusionRules): string {
  const segs = relPath.split('/');
  for (let i = 1; i < segs.length; i++) {
    const prefix = segs.slice(0, i).join('/');
    const c = classify(prefix, { ...rules, tracked: undefined });
    if (c && c.kind !== 'credential') return prefix + '/';
  }
  return relPath;
}

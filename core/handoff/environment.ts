// Environment notes. Everything here is a suggestion for the user to read;
// import never runs any of it.

import fs from 'node:fs';
import path from 'node:path';
import { inertLine, mdInlineCode } from '../common/sanitize.ts';
import type { EnvironmentInfo } from '../common/types.ts';

const read = (root: string, f: string): string | null => {
  try {
    return fs.readFileSync(path.join(root, f), 'utf8');
  } catch {
    return null;
  }
};

export function detectEnvironment(root: string, tools: EnvironmentInfo['tools'], excludedCredentials: string[]): EnvironmentInfo {
  const detected: EnvironmentInfo['detected'] = [];
  const steps: EnvironmentInfo['steps'] = [];
  const has = (f: string) => fs.existsSync(path.join(root, f));

  for (const f of ['.nvmrc', '.node-version', '.python-version', '.ruby-version', '.tool-versions']) {
    const v = read(root, f);
    if (v) detected.push({ file: f, kind: 'runtime version', detail: v.trim().split('\n').slice(0, 5).join('; ').slice(0, 400) });
  }
  const pkgText = read(root, 'package.json');
  if (pkgText) {
    try {
      const pkg = JSON.parse(pkgText) as { engines?: { node?: string }; packageManager?: string };
      if (pkg.engines?.node) detected.push({ file: 'package.json', kind: 'node version', detail: pkg.engines.node });
      if (pkg.packageManager) detected.push({ file: 'package.json', kind: 'package manager', detail: pkg.packageManager });
    } catch {
      detected.push({ file: 'package.json', kind: 'warning', detail: 'not valid JSON' });
    }
  }
  const installs: Array<[string, string, string]> = [
    ['package-lock.json', 'Install Node dependencies', 'npm ci'],
    ['pnpm-lock.yaml', 'Install Node dependencies', 'pnpm install --frozen-lockfile'],
    ['yarn.lock', 'Install Node dependencies', 'yarn install --frozen-lockfile'],
    ['bun.lock', 'Install Node dependencies', 'bun install'],
    ['uv.lock', 'Install Python dependencies', 'uv sync'],
    ['poetry.lock', 'Install Python dependencies', 'poetry install'],
    ['Pipfile.lock', 'Install Python dependencies', 'pipenv install'],
    ['Cargo.toml', 'Fetch Rust dependencies', 'cargo build'],
    ['go.mod', 'Fetch Go modules', 'go mod download'],
    ['Gemfile', 'Install Ruby gems', 'bundle install'],
    ['composer.json', 'Install PHP dependencies', 'composer install'],
  ];
  for (const [file, title, command] of installs) {
    if (has(file)) {
      detected.push({ file, kind: 'dependencies', detail: title });
      steps.push({ title, command, note: `Because ${file} is present.` });
    }
  }
  if (pkgText && !steps.some((s) => s.title === 'Install Node dependencies')) steps.push({ title: 'Install Node dependencies', command: 'npm install', note: 'package.json has no lockfile.' });
  if (has('requirements.txt') && !steps.some((s) => s.title === 'Install Python dependencies')) {
    steps.push({ title: 'Install Python dependencies', command: 'python -m pip install -r requirements.txt', note: 'Create and activate a virtual environment first; activation differs between macOS and Windows.' });
  }

  const envVarNames: string[] = [];
  for (const f of ['.env.example', '.env.sample', '.env.template']) {
    const t = read(root, f);
    if (t) for (const m of t.matchAll(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/gm)) envVarNames.push(m[1]);
  }
  if (excludedCredentials.length || envVarNames.length) {
    steps.push({
      title: 'Recreate credentials and environment files',
      command: null,
      note: `Not transferred: ${excludedCredentials.slice(0, 10).join(', ') || 'none'}${envVarNames.length ? `. Variables named in the example file: ${[...new Set(envVarNames)].slice(0, 30).join(', ')}` : ''}.`,
    });
  }
  steps.push({ title: 'Restart dev servers and watchers', command: null, note: 'Running processes are not transferred; start them again on this computer.' });

  return {
    source: { platform: process.platform, arch: process.arch },
    tools,
    detected,
    steps,
    envVarNames: [...new Set(envVarNames)],
    excludedCredentials,
    notes: ['Session Capsule never runs these commands. Review each one before running it yourself.'],
  };
}

export function renderEnvironmentMarkdown(env: EnvironmentInfo): string {
  const lines = ['# Environment setup', '', '**Review before running. Session Capsule never runs these steps, and they came from another computer.**', ''];
  lines.push(`Source computer: ${inertLine(env.source.platform)} (${inertLine(env.source.arch)})`, '');
  if (env.tools.length) lines.push('## Tools on the source', '', ...env.tools.map((t) => `- ${inertLine(t.name)}: ${t.version ? inertLine(t.version) : 'version unknown'}${t.note ? ` — ${inertLine(t.note, 300)}` : ''}`), '');
  if (env.detected.length) lines.push('## Detected', '', ...env.detected.map((d) => `- ${mdInlineCode(d.file)} — ${inertLine(d.kind)}: ${inertLine(d.detail, 300)}`), '');
  lines.push('## Suggested steps', '');
  env.steps.forEach((s, i) => lines.push(`${i + 1}. ${inertLine(s.title)}${s.command ? `: ${mdInlineCode(s.command)}` : ''}${s.note ? ` — ${inertLine(s.note, 600)}` : ''}`));
  return lines.join('\n') + '\n';
}

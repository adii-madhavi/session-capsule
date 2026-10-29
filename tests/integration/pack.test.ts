import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { gitProject, isolateAppHome, packTo, tmpDir, writeFiles } from '../fixtures/helpers.ts';
import { CapsuleError, openCapsule } from '../../core/archive/capsule.ts';
import { CaptureUnstableError, reviewPack } from '../../core/pack.ts';
import { ZipReader } from '../../core/archive/zip.ts';
import { claudeCodeAdapter, projectSlug } from '../../adapters/claude-code/index.ts';
import { codexAdapter } from '../../adapters/codex/index.ts';
import { DEFAULT_EXTRACT } from '../../adapters/types.ts';

const home = isolateAppHome();
const SECRET = 'sk-ant-api03-SUPERSECRETvalue1234567890';

function claudeSession(project: string): string {
  const dir = tmpDir('sc-claude');
  process.env.CLAUDE_CONFIG_DIR = dir;
  const sessionDir = path.join(dir, 'projects', projectSlug(project));
  fs.mkdirSync(sessionDir, { recursive: true });
  const base = { cwd: project, sessionId: 's1', version: '2.1.309', entrypoint: 'claude-desktop' };
  const lines = [
    { ...base, type: 'user', uuid: 'u1', timestamp: '2026-10-29T10:00:00Z', message: { role: 'user', content: `Fix the parser. My key is ${SECRET}<system-reminder>hidden harness text</system-reminder>` } },
    { ...base, type: 'assistant', uuid: 'a1', timestamp: '2026-10-29T10:00:05Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'Running the tests \u001b[31mnow\u001b[0m' }, { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } },
    { ...base, type: 'user', uuid: 'u2', timestamp: '2026-10-29T10:00:09Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'x'.repeat(10_000) }] }] } },
    { ...base, type: 'assistant', uuid: 'a2', isSidechain: true, timestamp: '2026-10-29T10:00:10Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sub-agent chatter' }] } },
    { type: 'custom-title', customTitle: 'Parser fix', sessionId: 's1' },
  ];
  fs.writeFileSync(path.join(sessionDir, 's1.jsonl'), lines.map((l) => JSON.stringify(l)).join('\n') + '\n{"torn":');
  return dir;
}

test('Claude Code adapter: attribution, omissions, actions, truncation', () => {
  const project = tmpDir('sc-proj');
  claudeSession(project);
  const [s] = claudeCodeAdapter.listSessions(project);
  assert.equal(s.title, 'Parser fix');
  assert.equal(s.surface, 'desktop');
  const doc = claudeCodeAdapter.extract(s, DEFAULT_EXTRACT);
  assert.deepEqual(doc.messages.map((m) => `${m.role}/${m.kind}`), ['user/text', 'assistant/text', 'assistant/tool-call', 'tool/tool-result']);
  assert.ok(!JSON.stringify(doc).includes('hidden harness text') && !JSON.stringify(doc).includes('private reasoning') && !JSON.stringify(doc).includes('sub-agent chatter'));
  assert.equal(doc.messages[2].action?.summary, 'npm test');
  assert.ok(doc.messages[3].truncated);
  assert.ok(doc.messages.every((m) => m.source.startsWith('claude-code:')));
  assert.ok(doc.notes.some((n) => /thinking/.test(n)) && doc.notes.some((n) => /sub-agent/.test(n)));
});

test('Codex adapter: compressed rollouts, injected context and developer text omitted, paginated marked partial', () => {
  if (typeof zlib.zstdCompressSync !== 'function') return;
  const project = tmpDir('sc-proj');
  const codex = tmpDir('sc-codex');
  process.env.CODEX_HOME = codex;
  const day = path.join(codex, 'sessions', '2026', '10', '29');
  fs.mkdirSync(day, { recursive: true });
  const rec = (type: string, payload: object) => JSON.stringify({ timestamp: '2026-10-29T10:00:00Z', type, payload });
  const rollout = [
    rec('session_meta', { id: 'th1', cwd: project, originator: 'Codex Desktop', cli_version: '0.163.0', history_mode: 'paginated', source: 'vscode' }),
    rec('response_item', { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system rules' }] }),
    rec('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>x</cwd>\n</environment_context>' }, { type: 'input_text', text: 'Add a CSV export' }] }),
    rec('response_item', { type: 'reasoning', summary: [] }),
    rec('response_item', { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'npm run build'] }), call_id: 'c1' }),
    rec('response_item', { type: 'function_call_output', call_id: 'c1', output: 'built' }),
    rec('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done with step one.' }] }),
  ].join('\n');
  fs.writeFileSync(path.join(day, 'rollout-2026-10-29T10-00-00-th1.jsonl.zst'), zlib.zstdCompressSync(Buffer.from(rollout)));
  fs.writeFileSync(path.join(codex, 'session_index.jsonl'), JSON.stringify({ id: 'th1', thread_name: 'CSV export' }) + '\n');
  const [s] = codexAdapter.listSessions(project);
  assert.equal(s.title, 'CSV export');
  assert.equal(s.surface, 'desktop');
  const doc = codexAdapter.extract(s, DEFAULT_EXTRACT);
  assert.deepEqual(doc.messages.map((m) => m.text), ['Add a CSV export', JSON.stringify({ command: ['bash', '-lc', 'npm run build'] }), 'built', 'Done with step one.']);
  assert.equal(doc.messages[1].action?.summary, 'bash -lc npm run build');
  assert.equal(doc.completeness, 'possibly-partial');
});

test('privacy: credential files excluded, conversation secrets redacted, logs hold no content', async () => {
  const project = gitProject({ 'app.js': 'console.log(1);\n' });
  writeFiles(project, { '.env': `ANTHROPIC_API_KEY=${SECRET}\n`, 'config/settings.js': `const key = "${SECRET}";\n` });
  claudeSession(project);
  const review = reviewPack({ projectRoot: project, mode: 'full', tool: 'claude-code', out: '-' });
  assert.ok(review.excluded.some((e) => e.path === '.env'));
  assert.ok(review.fileSecretFindings.some((f) => f.path === 'config/settings.js' && f.type === 'anthropic-key'), 'secrets inside included files are flagged for review');
  assert.ok(!JSON.stringify(review.fileSecretFindings).includes('SUPERSECRET'));
  assert.ok(review.redactions >= 1);

  const file = await packTo({ projectRoot: project, tool: 'claude-code', exclude: ['config/settings.js'] });
  const zip = ZipReader.open(file);
  for (const e of zip.entries) assert.ok(!zip.read(e).toString('latin1').includes('SUPERSECRET'), `secret found in ${e.name}`);
  zip.close();
  const log = fs.readFileSync(path.join(home, 'logs', 'capsule.log'), 'utf8');
  assert.ok(!log.includes('SUPERSECRET') && !log.includes('Fix the parser') && !log.includes('console.log'), 'logs contain no secrets, conversation or file content');
});

test('files changing during capture: retried, then refused with the files named', async () => {
  const project = gitProject({ 'a.txt': 'a\n', 'b.txt': 'b\n' });
  let attempts = 0;
  const ok = await packTo({
    projectRoot: project,
    hooks: { afterFile: (rel, attempt) => { attempts = attempt; if (attempt === 1 && rel === 'b.txt') writeFiles(project, { 'a.txt': 'changed during capture\n' }); } },
  });
  assert.equal(attempts, 2);
  const c = openCapsule(ok);
  assert.equal(c.readPayload('a.txt').toString(), 'changed during capture\n', 'the retry captured the settled content');
  c.close();

  let n = 0;
  await assert.rejects(
    packTo({ projectRoot: project, retries: 2, hooks: { afterFile: (rel) => { if (rel === 'b.txt') writeFiles(project, { 'a.txt': `edit ${n++}\n` }); } } }),
    (e: unknown) => e instanceof CaptureUnstableError && e.paths.includes('a.txt'),
  );
  assert.ok(!fs.readdirSync(path.dirname(ok)).some((f) => f.includes('.partial-')), 'no partial capsule is left behind');
});

test('encrypted capsule: needs the passphrase and rejects a wrong one', async () => {
  const project = gitProject({ 'a.txt': 'a\n' });
  const file = await packTo({ projectRoot: project, passphrase: 'a long passphrase' });
  assert.ok(!fs.readFileSync(file).includes(Buffer.from('session-capsule/')), 'nothing readable without the passphrase');
  assert.throws(() => openCapsule(file), (e: unknown) => e instanceof CapsuleError && e.code === 'passphrase-required');
  assert.throws(() => openCapsule(file, { passphrase: 'wrong' }), (e: unknown) => e instanceof CapsuleError && e.code === 'wrong-passphrase');
  const c = openCapsule(file, { passphrase: 'a long passphrase' });
  assert.equal(c.encrypted, true);
  assert.equal(c.readPayload('a.txt').toString(), 'a\n');
  c.close();
});

test('every capsule carries a handoff object that names its capsule and says restore is unsupported', async () => {
  const project = gitProject({ 'a.txt': 'a\n' });
  const c = openCapsule(await packTo({ projectRoot: project }));
  assert.equal(c.handoff.capsule?.id, c.manifest.capsuleId);
  assert.equal(c.handoff.capsule?.files[0].path, 'a.txt');
  assert.equal(c.manifest.restoration.native, 'unsupported');
  assert.match(c.continuation, /not a restored session/);
  assert.match(c.continuation, /_Not recorded\. Ask the user/);
  c.close();
});

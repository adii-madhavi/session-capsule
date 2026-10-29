import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { cloneOf, forgeCapsule, git, gitProject, isolateAppHome, packTo, read, treeHash, writeFiles, tmpDir } from '../fixtures/helpers.ts';
import { CapsuleError, openCapsule } from '../../core/archive/capsule.ts';
import { contextReport, planImport } from '../../core/restore/plan.ts';
import { applyImport, resumeImport, rollbackImport, SimulatedInterruption, UnresolvedError } from '../../core/restore/apply.ts';
import { loadJournal } from '../../core/restore/journal.ts';
import { writeHandoffFiles } from '../../core/restore/handoff-files.ts';
import { sha256 } from '../../core/common/hash.ts';

isolateAppHome();

const BASE = { 'src/a.txt': 'alpha\n', 'src/b.txt': 'bravo\n', 'old.txt': 'old\n', 'tool.sh': '#!/bin/sh\necho hi\n' };

async function workInProgress() {
  const src = gitProject(BASE);
  const dest = cloneOf(src);
  writeFiles(src, { 'src/a.txt': 'alpha v2\n', 'new/c.bin': Buffer.from([0, 255, 1, 2, 0]), 'untracked.md': 'notes\n' });
  fs.rmSync(path.join(src, 'old.txt'));
  const capsule = await packTo({ projectRoot: src });
  return { src, dest, capsule };
}

test('full round trip: edits, binary, new and deleted files are byte-identical; re-import changes nothing', async () => {
  const { src, dest, capsule } = await workInProgress();
  const c = openCapsule(capsule);
  const plan = planImport(c, dest);
  assert.deepEqual([plan.counts.create, plan.counts.update, plan.counts.delete, plan.counts.conflict], [2, 1, 1, 0]);
  assert.equal(plan.project.sameCommit, true);
  applyImport(c, plan, { deletions: 'apply' });
  for (const f of ['src/a.txt', 'src/b.txt', 'new/c.bin', 'untracked.md', 'tool.sh']) {
    assert.equal(sha256(fs.readFileSync(path.join(dest, f))), sha256(fs.readFileSync(path.join(src, f))), f);
  }
  assert.ok(!fs.existsSync(path.join(dest, 'old.txt')));
  const again = planImport(c, dest);
  assert.equal(again.counts.unchanged, 5);
  assert.equal(again.counts.create + again.counts.update + again.counts.delete + again.counts.conflict, 0);
  assert.equal(again.previousImports.length, 1, 'the earlier import is reported');
  c.close();
});

test('conflicts are never silently overwritten; keep, incoming and both behave as chosen', async () => {
  const { dest, capsule } = await workInProgress();
  writeFiles(dest, { 'src/a.txt': 'alpha edited on the PC\n', 'old.txt': 'old, but edited on the PC\n' });
  const c = openCapsule(capsule);
  const plan = planImport(c, dest);
  assert.equal(plan.counts.conflict, 1);
  assert.equal(plan.counts['delete-conflict'], 1);
  const before = treeHash(dest);
  assert.throws(() => applyImport(c, plan, { deletions: 'apply' }), UnresolvedError);
  assert.deepEqual(treeHash(dest), before, 'nothing changed while decisions were missing');

  applyImport(c, plan, { deletions: 'apply', defaultConflict: 'both' });
  assert.equal(read(dest, 'src/a.txt'), 'alpha edited on the PC\n', 'destination version kept');
  const sibling = fs.readdirSync(path.join(dest, 'src')).find((n) => n.includes('.from-capsule-'));
  assert.ok(sibling && read(dest, `src/${sibling}`) === 'alpha v2\n', 'incoming version saved beside it');
  assert.equal(read(dest, 'old.txt'), 'old, but edited on the PC\n', 'a locally changed file is not deleted under "both"');
  c.close();
});

test('deletions need an explicit decision and are skipped on request', async () => {
  const { dest, capsule } = await workInProgress();
  const c = openCapsule(capsule);
  const plan = planImport(c, dest);
  assert.throws(() => applyImport(c, plan, {}), /need a decision/);
  applyImport(c, plan, { deletions: 'skip' });
  assert.ok(fs.existsSync(path.join(dest, 'old.txt')));
  c.close();
});

test('interrupted import: rollback restores the originals exactly; resume finishes consistently', async () => {
  const { dest, capsule } = await workInProgress();
  const original = treeHash(dest);
  const c = openCapsule(capsule);
  let importId = '';
  assert.throws(() => applyImport(c, planImport(c, dest), { deletions: 'apply' }, { failAfter: 2 }), SimulatedInterruption);
  importId = fs.readdirSync(path.join(process.env.SESSION_CAPSULE_HOME as string, 'imports')).map((id) => loadJournal(id)).find((j) => j.dest === dest && j.state === 'applying')!.importId;
  assert.notDeepEqual(treeHash(dest), original, 'part of the import was applied');
  rollbackImport(importId);
  assert.deepEqual(treeHash(dest), original, 'rollback restores every file and removes created ones');
  assert.equal(loadJournal(importId).state, 'rolled-back');

  assert.throws(() => applyImport(c, planImport(c, dest), { deletions: 'apply' }, { failAfter: 1 }), SimulatedInterruption);
  const second = fs.readdirSync(path.join(process.env.SESSION_CAPSULE_HOME as string, 'imports')).map((id) => loadJournal(id)).find((j) => j.dest === dest && j.state === 'applying')!;
  resumeImport(second.importId, c);
  assert.equal(loadJournal(second.importId).state, 'applied');
  const after = planImport(c, dest);
  assert.equal(after.counts.create + after.counts.update + after.counts.delete, 0, 'resumed import ends consistent');
  c.close();
});

test('rollback keeps files the user changed after the import unless forced', async () => {
  const { dest, capsule } = await workInProgress();
  const c = openCapsule(capsule);
  const { importId } = applyImport(c, planImport(c, dest), { deletions: 'apply' });
  writeFiles(dest, { 'src/a.txt': 'user kept working\n' });
  const r = rollbackImport(importId);
  assert.deepEqual(r.keptModified, ['src/a.txt']);
  assert.equal(read(dest, 'src/a.txt'), 'user kept working\n');
  c.close();
});

test('unsafe or damaged capsules are rejected before any write', () => {
  const dest = tmpDir('sc-dest');
  writeFiles(dest, { 'keep.txt': 'keep\n' });
  const before = treeHash(dest);
  const cases: Array<[string, string, RegExp]> = [
    [forgeCapsule({ rawEntries: [{ name: 'session-capsule/payload/../../escape.txt', data: Buffer.from('x') }] }), 'unsafe', /unsafe file path/],
    [forgeCapsule({ files: [{ path: '.git/hooks/post-checkout', data: '#!/bin/sh\n' }] }), 'unsafe', /\.git/],
    [forgeCapsule({ rawEntries: [{ name: 'session-capsule/payload/link', data: Buffer.from('/etc/passwd'), unixMode: 0o120777 }] }), 'unsafe', /symbolic links/],
    [forgeCapsule({ manifest: { formatVersion: '2.0' } }), 'unsupported-version', /format 2\.0/],
    [forgeCapsule({ rawEntries: [{ name: 'evil.txt', data: Buffer.from('x') }] }), 'invalid', /outside the capsule folder/],
  ];
  for (const [file, code, message] of cases) {
    assert.throws(() => openCapsule(file), (e: unknown) => e instanceof CapsuleError && e.code === code && message.test(e.message), code);
  }
  const good = forgeCapsule({ files: [{ path: 'a.txt', data: 'a'.repeat(5000) }] });
  const bytes = fs.readFileSync(good);
  bytes[60] ^= 0xff;
  fs.writeFileSync(good, bytes);
  assert.throws(() => openCapsule(good), (e: unknown) => e instanceof CapsuleError && e.code === 'corrupted');
  const big = forgeCapsule({ files: [{ path: 'big.bin', data: Buffer.alloc(3 * 1024 * 1024) }] });
  assert.throws(() => openCapsule(big, { limits: { maxTotalSize: 1024 * 1024 } }), (e: unknown) => e instanceof CapsuleError && e.code === 'too-large');
  assert.deepEqual(treeHash(dest), before);
});

test('Windows destination: invalid names and case collisions are blocked before writing', () => {
  const capsule = forgeCapsule({ files: [{ path: 'aux.txt', data: 'x' }, { path: 'notes/a:b.txt', data: 'x' }, { path: 'README.md', data: '1' }, { path: 'readme.md', data: '2' }, { path: 'fine.txt', data: 'ok' }] });
  const dest = tmpDir('sc-dest');
  const c = openCapsule(capsule);
  const plan = planImport(c, dest, 'win32');
  const blocked = plan.ops.filter((o) => o.kind === 'blocked').map((o) => o.path).sort();
  assert.deepEqual(blocked, ['README.md', 'aux.txt', 'notes/a:b.txt', 'readme.md'].sort());
  assert.throws(() => applyImport(c, plan, {}), /can't be written here safely/);
  assert.deepEqual(fs.readdirSync(dest), []);
  applyImport(c, plan, { skip: blocked });
  assert.deepEqual(fs.readdirSync(dest), ['fine.txt']);
  c.close();
});

test('existing case-only differences and symlinked folders at the destination are blocked', () => {
  const dest = tmpDir('sc-dest');
  writeFiles(dest, { 'Docs/guide.md': 'mine\n' });
  fs.mkdirSync(path.join(dest, 'outside-target'));
  fs.symlinkSync(path.join(dest, 'outside-target'), path.join(dest, 'linked'));
  const c = openCapsule(forgeCapsule({ files: [{ path: 'docs/guide.md', data: 'incoming\n' }, { path: 'linked/x.txt', data: 'x' }] }));
  const plan = planImport(c, dest, 'darwin');
  assert.deepEqual(plan.ops.map((o) => o.kind), ['blocked', 'blocked']);
  c.close();
});

test('line-ending-only differences (git autocrlf) are treated as unchanged, and CRLF checkouts stay CRLF', async () => {
  const src = gitProject({ 'a.txt': 'one\ntwo\n', 'b.txt': 'x\ny\n' });
  const dest = cloneOf(src);
  writeFiles(dest, { 'a.txt': 'one\r\ntwo\r\n', 'b.txt': 'x\r\ny\r\n' });
  writeFiles(src, { 'b.txt': 'x\ny\nz\n' });
  const c = openCapsule(await packTo({ projectRoot: src }));
  const plan = planImport(c, dest);
  const byPath = Object.fromEntries(plan.ops.map((o) => [o.path, o.kind]));
  assert.equal(byPath['a.txt'], 'unchanged');
  assert.equal(byPath['b.txt'], 'update');
  applyImport(c, plan, {});
  assert.equal(read(dest, 'b.txt'), 'x\r\ny\r\nz\r\n');
  c.close();
});

test('context-only: mismatches are explained and no project file is written', async () => {
  const src = gitProject(BASE);
  writeFiles(src, { 'src/a.txt': 'alpha v2\n' });
  const dest = cloneOf(src);
  const capsule = await packTo({ projectRoot: src, mode: 'context-only' });
  const c = openCapsule(capsule);
  assert.ok(c.files.entries.every((e) => !e.inPayload));
  const plan = planImport(c, dest);
  const report = contextReport(c, plan);
  assert.deepEqual(report.different, ['src/a.txt']);
  assert.deepEqual(report.uncommittedOnSource, ['src/a.txt']);
  assert.ok(report.explanation.some((e) => /uncommitted/.test(e)));
  const before = treeHash(dest);
  assert.throws(() => applyImport(c, plan, {}), /context-only/);
  writeHandoffFiles(c, dest, { importId: null, filesApplied: false, contextCheck: report });
  const after = treeHash(dest);
  for (const k of Object.keys(before)) assert.equal(after[k], before[k], k);
  assert.ok(Object.keys(after).every((k) => k in before || k.startsWith('.session-capsule')));
  assert.equal(git(dest, 'status', '--porcelain'), '', 'handoff files ignore themselves in git');
  c.close();
});

test('commands inside a capsule are never executed on import', () => {
  const marker = path.join(tmpDir('sc-marker'), 'pwned');
  const capsule = forgeCapsule({
    files: [{ path: 'package.json', data: JSON.stringify({ scripts: { postinstall: `touch ${marker}` } }) }],
    environment: { steps: [{ title: 'Install', command: `touch ${marker}`, note: null }] },
  });
  const dest = tmpDir('sc-dest');
  const c = openCapsule(capsule);
  applyImport(c, planImport(c, dest), {});
  const h = writeHandoffFiles(c, dest, { importId: null, filesApplied: true, contextCheck: null });
  assert.ok(fs.readFileSync(path.join(h.dir, 'environment.md'), 'utf8').includes('never runs'));
  assert.ok(!fs.existsSync(marker));
  c.close();
});

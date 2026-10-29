import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ZipReader, ZipWriter } from '../../core/archive/zip.ts';
import { decryptFile, encryptFile, PassphraseError } from '../../core/archive/encryption.ts';
import { archivePathError, platformIssues } from '../../core/common/paths.ts';
import { classify } from '../../core/capture/exclusions.ts';
import { findSecrets, redactSecrets } from '../../core/common/secrets.ts';
import { inert, mdFence } from '../../core/common/sanitize.ts';
import { tmpDir } from '../fixtures/helpers.ts';

test('archive paths: traversal, absolute, drive letters, backslashes and .git are rejected', () => {
  for (const p of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', '', 'a//b', './a', '.git/hooks/post-checkout', '.GIT/config', '.git./x', 'sub/.git::$INDEX_ALLOCATION/x', 'GIT~1/x', '.session-capsule/x', 'e\u0301.txt']) {
    assert.ok(archivePathError(p), `should reject ${JSON.stringify(p)}`);
  }
  for (const p of ['src/a.ts', 'docs/.gitignore', 'a b/c.d', 'é.txt']) assert.equal(archivePathError(p), null, p);
});

test('Windows rules: invalid characters, reserved names, trailing dots, case collisions', () => {
  const issues = platformIssues(['a:b.txt', 'aux.txt', 'com1', 'x/name.', 'README.md', 'Readme.md', 'Src/a', 'src/b', 'ok.txt'], 'win32');
  const kinds = (p: string) => issues.filter((i) => i.path === p).map((i) => i.kind);
  assert.deepEqual(kinds('a:b.txt'), ['invalid-name']);
  assert.deepEqual(kinds('aux.txt'), ['reserved-name']);
  assert.deepEqual(kinds('com1'), ['reserved-name']);
  assert.deepEqual(kinds('x/name.'), ['invalid-name']);
  assert.ok(issues.some((i) => i.kind === 'case-collision' && i.blocking && /README\.md|Readme\.md/.test(i.detail)));
  assert.ok(issues.some((i) => i.kind === 'case-collision' && !i.blocking && /folders/.test(i.detail)));
  assert.deepEqual(kinds('ok.txt'), []);
  assert.equal(platformIssues(['a:b.txt', 'README.md', 'readme.md'], 'linux').length, 0);
});

test('default exclusions: credentials, dependencies, build output; templates and user includes kept', () => {
  const r = { include: [], exclude: [] };
  for (const p of ['.env', 'config/secrets.yaml', 'config/.env.local', 'certs/server.pem', 'id_ed25519', '.npmrc', 'node_modules/x/index.js', 'dist/app.js', '.git/HEAD', 'a/.DS_Store']) {
    assert.ok(classify(p, r), `should exclude ${p}`);
  }
  for (const p of ['.env.example', 'id_ed25519.pub', 'src/build.ts', 'docs/README.md', 'core/common/secrets.ts', 'lib/secrets.py']) assert.equal(classify(p, r), null, p);
  assert.equal(classify('dist/app.js', { ...r, tracked: () => true }), null, 'committed build output is kept in git projects');
  assert.equal(classify('.env', { include: ['.env'], exclude: [] }), null, 'the user can include a credential file on purpose');
  assert.ok(classify('.git/config', { include: ['**'], exclude: [] }), '.git is never included');
});

test('secret redaction and file findings never return the secret', () => {
  const text = 'key sk-ant-api03-abcdefghijklmnopqrstuvwx and ghp_abcdefghijklmnopqrstuvwxyz0123456789AB\nTOKEN=hunter2hunter2\nAPI_KEY=process.env.API_KEY\npostgres://me:pa55word@db/x';
  const r = redactSecrets(text);
  for (const s of ['abcdefghijklmnopqrstuvwx', 'ghp_abc', 'hunter2hunter2', 'pa55word']) assert.ok(!r.text.includes(s), s);
  assert.ok(r.text.includes('API_KEY=process.env.API_KEY'), 'references to secrets are kept');
  assert.equal(r.count, 4);
  const f = findSecrets(text);
  assert.ok(f.length >= 3 && !JSON.stringify(f).includes('hunter2'));
});

test('display safety: escape sequences and bidi controls are removed; fences cannot be broken', () => {
  const evil = 'ok\u001b[2J\u001b]0;pwned\u0007\u202eeman\u0000 ```\n<script>alert(1)</script>';
  const clean = inert(evil);
  assert.ok(!/[\u001b\u0007\u202e\u0000]/.test(clean));
  const fenced = mdFence('a ```` b');
  assert.ok(fenced.startsWith('`````text'), 'fence is longer than any backtick run inside');
});

test('zip: round trip, symlink entries rejected, lying sizes caught', () => {
  const dir = tmpDir();
  const ok = path.join(dir, 'ok.zip');
  const z = new ZipWriter(ok);
  z.add('session-capsule/a.txt', Buffer.from('hello'.repeat(1000)));
  z.finish();
  const r = ZipReader.open(ok);
  assert.equal(r.read(r.get('session-capsule/a.txt')!).toString(), 'hello'.repeat(1000));
  r.close();

  const link = path.join(dir, 'link.zip');
  const zl = new ZipWriter(link);
  zl.add('session-capsule/payload/x', Buffer.from('/etc/passwd'), { unixMode: 0o120777 });
  zl.finish();
  assert.throws(() => ZipReader.open(link), /symbolic links/);

  // Claim a smaller uncompressed size than the data inflates to.
  const bomb = path.join(dir, 'bomb.zip');
  const zb = new ZipWriter(bomb);
  zb.add('session-capsule/z', Buffer.alloc(200_000));
  zb.finish();
  const bytes = fs.readFileSync(bomb);
  const cd = bytes.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(10, cd + 24);
  fs.writeFileSync(bomb, bytes);
  const rb = ZipReader.open(bomb);
  assert.throws(() => rb.read(rb.get('session-capsule/z')!), /damaged|size/);
  rb.close();

  assert.throws(() => ZipReader.open(bomb, { maxEntries: 10, maxEntrySize: 1, maxTotalSize: 1, maxRatio: 1100 }), /limit|size/);
});

test('encryption: round trip, wrong passphrase, tampering and truncation', () => {
  const dir = tmpDir();
  const plain = path.join(dir, 'p');
  fs.writeFileSync(plain, Buffer.alloc(3 * 1024 * 1024 + 17, 7));
  const enc = path.join(dir, 'e');
  encryptFile(plain, enc, 'correct horse', 2 ** 10);
  decryptFile(enc, path.join(dir, 'd'), 'correct horse');
  assert.ok(fs.readFileSync(path.join(dir, 'd')).equals(fs.readFileSync(plain)));
  assert.throws(() => decryptFile(enc, path.join(dir, 'w'), 'wrong'), PassphraseError);
  assert.ok(!fs.existsSync(path.join(dir, 'w')), 'no partial output on failure');
  const bytes = fs.readFileSync(enc);
  bytes[bytes.length - 40] ^= 1;
  fs.writeFileSync(path.join(dir, 't'), bytes);
  assert.throws(() => decryptFile(path.join(dir, 't'), path.join(dir, 't2'), 'correct horse'));
  fs.writeFileSync(path.join(dir, 'cut'), fs.readFileSync(enc).subarray(0, 1024 * 1024 + 200));
  assert.throws(() => decryptFile(path.join(dir, 'cut'), path.join(dir, 'cut2'), 'correct horse'));
});

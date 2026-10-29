// Capsule archive layer: writes the documented layout and fully validates a
// capsule (structure, versions, paths, hashes, schemas) before anything uses it.

import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../common/hash.ts';
import { archivePathError } from '../common/paths.ts';
import { validateNamed, type SchemaName } from '../common/schema.ts';
import { makeTempDir } from '../common/appdata.ts';
import {
  FORMAT_NAME,
  SUPPORTED_FORMAT_MAJOR,
  type ConversationDoc,
  type EnvironmentInfo,
  type FilesIndex,
  type HandoffObject,
  type IntegrityEntry,
  type Manifest,
} from '../common/types.ts';
import { DEFAULT_ZIP_LIMITS, ZipFormatError, ZipReader, ZipWriter, type ZipLimits } from './zip.ts';
import { DEFAULT_SCRYPT_N, EncryptedDataError, PassphraseError, decryptFile, encryptFile, isEncryptedFile } from './encryption.ts';

export const ROOT = 'session-capsule/';
export const PAYLOAD = `${ROOT}payload/`;
export const META_FILES = ['continuation.md', 'conversation.json', 'conversation.md', 'environment.json', 'files.json', 'handoff.json'] as const;
const REQUIRED_META = ['continuation.md', 'conversation.json', 'environment.json', 'files.json', 'handoff.json'];

export type CapsuleErrorCode =
  | 'passphrase-required'
  | 'wrong-passphrase'
  | 'unsupported-version'
  | 'corrupted'
  | 'unsafe'
  | 'too-large'
  | 'invalid';

export class CapsuleError extends Error {
  code: CapsuleErrorCode;
  constructor(code: CapsuleErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class CapsuleWriter {
  #zip: ZipWriter;
  #integrity: IntegrityEntry[] = [];

  constructor(tmpPath: string) {
    this.#zip = new ZipWriter(tmpPath);
  }

  addPayload(relPath: string, data: Buffer, executable: boolean): void {
    this.#zip.add(PAYLOAD + relPath, data, { executable });
  }

  addMeta(name: (typeof META_FILES)[number], content: string): void {
    const buf = Buffer.from(content, 'utf8');
    this.#zip.add(ROOT + name, buf);
    this.#integrity.push({ path: name, sha256: sha256(buf), size: buf.length });
  }

  finish(manifest: Omit<Manifest, 'integrity'>): Manifest {
    const full: Manifest = { ...manifest, integrity: this.#integrity };
    const errors = validateNamed('manifest', full);
    if (errors.length) throw new Error(`internal error: invalid manifest: ${errors.join('; ')}`);
    this.#zip.add(ROOT + 'manifest.json', Buffer.from(JSON.stringify(full, null, 2) + '\n', 'utf8'));
    this.#zip.finish();
    return full;
  }

  abort(): void {
    this.#zip.abort();
  }
}

// Move a finished archive to its destination, encrypting it on the way if asked.
export function finalizeCapsule(tmpZip: string, out: string, passphrase: string | null, scryptN = DEFAULT_SCRYPT_N): void {
  if (fs.existsSync(out)) throw new Error(`${out} already exists`);
  if (passphrase) {
    try {
      encryptFile(tmpZip, out, passphrase, scryptN);
    } finally {
      fs.rmSync(tmpZip, { force: true });
    }
  } else fs.renameSync(tmpZip, out);
}

export interface OpenedCapsule {
  file: string;
  encrypted: boolean;
  manifest: Manifest;
  files: FilesIndex;
  conversation: ConversationDoc;
  conversationMd: string | null;
  environment: EnvironmentInfo;
  handoff: HandoffObject;
  continuation: string;
  readPayload(relPath: string): Buffer;
  close(): void;
}

export interface OpenOptions {
  passphrase?: string | null;
  limits?: Partial<ZipLimits>;
}

function fromZipError(err: unknown): never {
  if (err instanceof ZipFormatError) {
    const code: CapsuleErrorCode = err.code === 'unsupported' ? 'corrupted' : err.code;
    throw new CapsuleError(code, err.message);
  }
  throw err;
}

function parseJson(reader: ZipReader, name: string): unknown {
  const entry = reader.get(ROOT + name);
  if (!entry) throw new CapsuleError('invalid', `capsule is missing ${name}`);
  try {
    return JSON.parse(reader.read(entry).toString('utf8'));
  } catch (err) {
    if (err instanceof ZipFormatError) fromZipError(err);
    throw new CapsuleError('corrupted', `${name} is not valid JSON`);
  }
}

function checkSchema(name: SchemaName, value: unknown): void {
  const errors = validateNamed(name, value);
  if (errors.length) throw new CapsuleError('invalid', `${name}.json does not match format 1.x: ${errors.slice(0, 3).join('; ')}`);
}

// Open and verify a capsule. Nothing is returned until every check has passed,
// so callers never act on a partially valid capsule.
export function openCapsule(file: string, opts: OpenOptions = {}): OpenedCapsule {
  let zipPath = file;
  let tmpDir: string | null = null;
  const cleanup = () => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  };

  const encrypted = isEncryptedFile(file);
  if (encrypted) {
    if (!opts.passphrase) throw new CapsuleError('passphrase-required', 'This capsule is encrypted. Enter its passphrase to open it.');
    tmpDir = makeTempDir('open');
    zipPath = path.join(tmpDir, 'capsule.zip');
    try {
      decryptFile(file, zipPath, opts.passphrase);
    } catch (err) {
      cleanup();
      if (err instanceof PassphraseError) throw new CapsuleError('wrong-passphrase', err.message);
      if (err instanceof EncryptedDataError) throw new CapsuleError('corrupted', err.message);
      throw err;
    }
  }

  let reader: ZipReader;
  try {
    reader = ZipReader.open(zipPath, { ...DEFAULT_ZIP_LIMITS, ...opts.limits });
  } catch (err) {
    cleanup();
    fromZipError(err);
  }

  try {
    const result = verify(reader, file, encrypted);
    const close = () => {
      reader.close();
      cleanup();
    };
    return { ...result, close };
  } catch (err) {
    reader.close();
    cleanup();
    if (err instanceof ZipFormatError) fromZipError(err);
    throw err;
  }
}

function verify(reader: ZipReader, file: string, encrypted: boolean): Omit<OpenedCapsule, 'close'> {
  // 1. Layout: only known metadata files and safe payload paths.
  const payloadEntries = new Map<string, (typeof reader.entries)[number]>();
  const metaPresent = new Set<string>();
  for (const e of reader.entries) {
    if (!e.name.startsWith(ROOT)) throw new CapsuleError('invalid', `unexpected file outside the capsule folder: ${e.name}`);
    if (e.isDirectory) continue;
    const rel = e.name.slice(ROOT.length);
    if (rel.startsWith('payload/')) {
      const p = rel.slice('payload/'.length);
      const problem = archivePathError(p);
      if (problem) throw new CapsuleError('unsafe', `unsafe file path in capsule (${problem}): ${JSON.stringify(p)}`);
      payloadEntries.set(p, e);
    } else if (rel === 'manifest.json' || (META_FILES as readonly string[]).includes(rel)) metaPresent.add(rel);
    else throw new CapsuleError('invalid', `unexpected file in capsule: ${rel}`);
  }

  // 2. Manifest and version.
  const manifest = parseJson(reader, 'manifest.json') as Manifest;
  if (!manifest || typeof manifest !== 'object' || manifest.format !== FORMAT_NAME) {
    throw new CapsuleError('invalid', 'not a Session Capsule (manifest has no session-capsule format marker)');
  }
  const major = Number(String(manifest.formatVersion ?? '').split('.')[0]);
  if (!Number.isInteger(major) || major !== SUPPORTED_FORMAT_MAJOR) {
    throw new CapsuleError(
      'unsupported-version',
      `This capsule uses format ${String(manifest.formatVersion)}; this version of Session Capsule reads format ${SUPPORTED_FORMAT_MAJOR}.x. Update Session Capsule on this computer.`,
    );
  }
  checkSchema('manifest', manifest);

  // 3. Metadata integrity.
  const listed = new Map(manifest.integrity.map((i) => [i.path, i]));
  for (const name of REQUIRED_META) if (!listed.has(name)) throw new CapsuleError('invalid', `manifest does not list ${name}`);
  for (const name of metaPresent) if (name !== 'manifest.json' && !listed.has(name)) throw new CapsuleError('invalid', `${name} is not covered by the manifest`);
  const metaText = new Map<string, string>();
  for (const item of manifest.integrity) {
    const entry = reader.get(ROOT + item.path);
    if (!entry) throw new CapsuleError('invalid', `capsule is missing ${item.path}`);
    const data = reader.read(entry);
    if (data.length !== item.size || sha256(data) !== item.sha256) throw new CapsuleError('corrupted', `${item.path} does not match its recorded hash`);
    metaText.set(item.path, data.toString('utf8'));
  }
  const json = (name: string): unknown => {
    try {
      return JSON.parse(metaText.get(name) as string);
    } catch {
      throw new CapsuleError('corrupted', `${name} is not valid JSON`);
    }
  };
  const files = json('files.json') as FilesIndex;
  checkSchema('files', files);
  const conversation = json('conversation.json') as ConversationDoc;
  checkSchema('conversation', conversation);
  const environment = json('environment.json') as EnvironmentInfo;
  checkSchema('environment', environment);
  const handoff = json('handoff.json') as HandoffObject;
  checkSchema('handoff', handoff);
  if (handoff.capsule && handoff.capsule.id !== manifest.capsuleId) throw new CapsuleError('invalid', 'handoff.json belongs to a different capsule');

  // 4. File index against payload.
  const seen = new Set<string>();
  for (const f of files.entries) {
    const problem = archivePathError(f.path);
    if (problem) throw new CapsuleError('unsafe', `unsafe file path in file index (${problem}): ${JSON.stringify(f.path)}`);
    if (seen.has(f.path)) throw new CapsuleError('invalid', `file listed twice: ${f.path}`);
    seen.add(f.path);
    if (manifest.mode === 'context-only' && f.inPayload) throw new CapsuleError('invalid', 'a context-only capsule cannot carry file contents');
    if (!f.inPayload) continue;
    const entry = payloadEntries.get(f.path);
    if (!entry) throw new CapsuleError('corrupted', `file contents missing from capsule: ${f.path}`);
    if (entry.size !== f.size) throw new CapsuleError('corrupted', `size mismatch for ${f.path}`);
    if (sha256(reader.read(entry)) !== f.sha256) throw new CapsuleError('corrupted', `${f.path} does not match its recorded hash`);
  }
  const index = new Map(files.entries.map((f) => [f.path, f]));
  for (const p of payloadEntries.keys()) {
    if (!index.get(p)?.inPayload) throw new CapsuleError('invalid', `file in capsule is not in the file index: ${p}`);
  }
  for (const d of files.deletions) {
    const problem = archivePathError(d.path);
    if (problem) throw new CapsuleError('unsafe', `unsafe deletion path (${problem}): ${JSON.stringify(d.path)}`);
    if (seen.has(d.path)) throw new CapsuleError('invalid', `file is both included and deleted: ${d.path}`);
  }

  return {
    file,
    encrypted,
    manifest,
    files,
    conversation,
    conversationMd: metaText.get('conversation.md') ?? null,
    environment,
    handoff,
    continuation: metaText.get('continuation.md') as string,
    readPayload(relPath: string): Buffer {
      const f = index.get(relPath);
      const entry = payloadEntries.get(relPath);
      if (!f || !entry) throw new CapsuleError('invalid', `no contents for ${relPath} in this capsule`);
      const data = reader.read(entry);
      if (sha256(data) !== f.sha256) throw new CapsuleError('corrupted', `${relPath} does not match its recorded hash`);
      return data;
    },
  };
}

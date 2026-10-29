// Optional passphrase encryption for a whole capsule file.
//
// Layout: "SCAPENC1" | u32 header length | header JSON | chunks...
// Each chunk is u32 ciphertext length | ciphertext | 16-byte GCM tag, encrypted
// with AES-256-GCM under a scrypt-derived key. The nonce is a random 7-byte
// prefix, the chunk counter and a final-chunk flag, so reordered, dropped or
// truncated chunks fail authentication. The header is bound to every chunk as
// associated data.

import crypto from 'node:crypto';
import fs from 'node:fs';
import { readExact, writeAll } from '../common/fsx.ts';

const MAGIC = Buffer.from('SCAPENC1', 'ascii');
const CHUNK_SIZE = 1024 * 1024;
const TAG_LEN = 16;
export const DEFAULT_SCRYPT_N = 2 ** 17;

export class PassphraseError extends Error {}
export class EncryptedDataError extends Error {}

interface Header {
  v: 1;
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  noncePrefix: string;
  chunkSize: number;
}

export function isEncryptedFile(file: string): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAGIC.length);
    return fs.readSync(fd, buf, 0, buf.length, 0) === buf.length && buf.equals(MAGIC);
  } finally {
    fs.closeSync(fd);
  }
}

function deriveKey(passphrase: string, h: Header): Buffer {
  return crypto.scryptSync(passphrase.normalize('NFC'), Buffer.from(h.salt, 'base64'), 32, {
    N: h.N,
    r: h.r,
    p: h.p,
    maxmem: 512 * 1024 * 1024,
  });
}

function nonceFor(prefix: Buffer, index: number, final: boolean): Buffer {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, 7);
  n[11] = final ? 1 : 0;
  return n;
}

function validHeader(h: unknown): h is Header {
  if (!h || typeof h !== 'object') return false;
  const x = h as Record<string, unknown>;
  const isPow2 = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 1 && (n & (n - 1)) === 0;
  return (
    x.v === 1 &&
    x.kdf === 'scrypt' &&
    isPow2(x.N) &&
    (x.N as number) >= 2 ** 10 &&
    (x.N as number) <= 2 ** 20 &&
    Number.isInteger(x.r) && (x.r as number) >= 1 && (x.r as number) <= 32 &&
    Number.isInteger(x.p) && (x.p as number) >= 1 && (x.p as number) <= 4 &&
    typeof x.salt === 'string' && Buffer.from(x.salt, 'base64').length === 16 &&
    typeof x.noncePrefix === 'string' && Buffer.from(x.noncePrefix, 'base64').length === 7 &&
    Number.isInteger(x.chunkSize) && (x.chunkSize as number) >= 1024 && (x.chunkSize as number) <= 16 * 1024 * 1024
  );
}

export function encryptFile(src: string, dest: string, passphrase: string, scryptN = DEFAULT_SCRYPT_N): void {
  if (!passphrase) throw new PassphraseError('A passphrase is required to encrypt a capsule.');
  const header: Header = {
    v: 1,
    kdf: 'scrypt',
    N: scryptN,
    r: 8,
    p: 1,
    salt: crypto.randomBytes(16).toString('base64'),
    noncePrefix: crypto.randomBytes(7).toString('base64'),
    chunkSize: CHUNK_SIZE,
  };
  const json = Buffer.from(JSON.stringify(header), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(json.length);
  const aad = Buffer.concat([MAGIC, len, json]);
  const key = deriveKey(passphrase, header);
  const prefix = Buffer.from(header.noncePrefix, 'base64');

  const inFd = fs.openSync(src, 'r');
  let outFd: number | null = null;
  try {
    const size = fs.fstatSync(inFd).size;
    outFd = fs.openSync(dest, 'wx', 0o600);
    writeAll(outFd, aad);
    const buf = Buffer.alloc(CHUNK_SIZE);
    let pos = 0;
    for (let index = 0; ; index++) {
      const n = Math.min(CHUNK_SIZE, size - pos);
      readExact(inFd, buf, n, pos);
      pos += n;
      const final = pos >= size;
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonceFor(prefix, index, final));
      cipher.setAAD(aad);
      const ct = Buffer.concat([cipher.update(buf.subarray(0, n)), cipher.final()]);
      const ctLen = Buffer.alloc(4);
      ctLen.writeUInt32BE(ct.length);
      writeAll(outFd, ctLen);
      writeAll(outFd, ct);
      writeAll(outFd, cipher.getAuthTag());
      if (final) break;
    }
    fs.fsyncSync(outFd);
    fs.closeSync(outFd);
    outFd = null;
  } catch (err) {
    if (outFd !== null) {
      fs.closeSync(outFd);
      fs.rmSync(dest, { force: true });
    }
    throw err;
  } finally {
    fs.closeSync(inFd);
  }
}

export function decryptFile(src: string, dest: string, passphrase: string): void {
  const inFd = fs.openSync(src, 'r');
  let outFd: number | null = null;
  try {
    const size = fs.fstatSync(inFd).size;
    const read = (pos: number, n: number) => {
      if (pos + n > size) throw new EncryptedDataError('The encrypted capsule is truncated.');
      const b = Buffer.alloc(n);
      readExact(inFd, b, n, pos);
      return b;
    };
    const magic = read(0, MAGIC.length);
    if (!magic.equals(MAGIC)) throw new EncryptedDataError('Not an encrypted capsule.');
    const hlen = read(MAGIC.length, 4).readUInt32BE(0);
    if (hlen > 4096) throw new EncryptedDataError('The encrypted capsule header is damaged.');
    const json = read(MAGIC.length + 4, hlen);
    let header: unknown;
    try {
      header = JSON.parse(json.toString('utf8'));
    } catch {
      throw new EncryptedDataError('The encrypted capsule header is damaged.');
    }
    if (!validHeader(header)) throw new EncryptedDataError('The encrypted capsule uses unsupported or unsafe settings.');
    const aad = Buffer.concat([magic, read(MAGIC.length, 4), json]);
    const key = deriveKey(passphrase, header);
    const prefix = Buffer.from(header.noncePrefix, 'base64');

    outFd = fs.openSync(dest, 'wx', 0o600);
    let pos = aad.length;
    for (let index = 0; ; index++) {
      const n = read(pos, 4).readUInt32BE(0);
      if (n > header.chunkSize) throw new EncryptedDataError('The encrypted capsule is damaged.');
      const ct = read(pos + 4, n);
      const tag = read(pos + 4 + n, TAG_LEN);
      pos += 4 + n + TAG_LEN;
      const final = pos === size;
      if (!final && n !== header.chunkSize) throw new EncryptedDataError('The encrypted capsule is damaged.');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonceFor(prefix, index, final));
      decipher.setAAD(aad);
      decipher.setAuthTag(tag);
      let plain: Buffer;
      try {
        plain = Buffer.concat([decipher.update(ct), decipher.final()]);
      } catch {
        if (index === 0) throw new PassphraseError('Could not decrypt the capsule: the passphrase is wrong or the file is damaged.');
        throw new EncryptedDataError('The encrypted capsule is damaged or was modified.');
      }
      writeAll(outFd, plain);
      if (final) break;
    }
    fs.fsyncSync(outFd);
    fs.closeSync(outFd);
    outFd = null;
  } catch (err) {
    if (outFd !== null) {
      fs.closeSync(outFd);
      fs.rmSync(dest, { force: true });
    }
    throw err;
  } finally {
    fs.closeSync(inFd);
  }
}

// Strict ZIP reader/writer for capsule archives. Capsules are ordinary ZIP files
// (openable with any unzip tool), but the reader accepts only what the writer
// produces: no ZIP64, no encryption, no links or special files, no overlapping
// entries, and declared sizes are enforced while inflating.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { readExact, writeAll } from '../common/fsx.ts';

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;
const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;

export type ZipErrorCode = 'corrupted' | 'unsafe' | 'too-large' | 'unsupported';

export class ZipFormatError extends Error {
  code: ZipErrorCode;
  constructor(code: ZipErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface ZipLimits {
  maxEntries: number;
  maxEntrySize: number;
  maxTotalSize: number;
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 65000,
  maxEntrySize: 1024 ** 3,
  maxTotalSize: 4 * 1024 ** 3,
  maxRatio: 1100,
};

function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.min(Math.max(d.getFullYear(), 1980), 2107);
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface AddOptions {
  executable?: boolean;
  mtime?: Date;
  // Raw Unix mode override; only tests use it, to build hostile archives.
  unixMode?: number;
}

export class ZipWriter {
  #fd: number;
  #path: string;
  #offset = 0;
  #central: Buffer[] = [];
  #count = 0;
  #names = new Set<string>();
  #done = false;

  constructor(filePath: string) {
    this.#path = filePath;
    this.#fd = fs.openSync(filePath, 'wx', 0o600);
  }

  add(name: string, data: Buffer, opts: AddOptions = {}): void {
    if (this.#names.has(name)) throw new Error(`duplicate archive entry: ${name}`);
    if (this.#count >= DEFAULT_ZIP_LIMITS.maxEntries) {
      throw new ZipFormatError('too-large', `too many files for capsule format 1.x (limit ${DEFAULT_ZIP_LIMITS.maxEntries})`);
    }
    this.#names.add(name);
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data);
    let method = 8;
    let body: Buffer = zlib.deflateRawSync(data, { level: 6 });
    if (body.length >= data.length) {
      method = 0;
      body = data;
    }
    if (data.length > MAX_U32 || this.#offset + 30 + nameBuf.length + body.length > MAX_U32) {
      throw new ZipFormatError('too-large', 'capsules larger than 4 GiB are not supported by format 1.x');
    }
    const { time, date } = dosDateTime(opts.mtime ?? new Date());
    const mode = opts.unixMode ?? (S_IFREG | (opts.executable ? 0o755 : 0o644));

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(CENTRAL_SIG, 0);
    central.writeUInt16LE((3 << 8) | 20, 4); // made by Unix
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(((mode & 0xffff) * 0x10000) >>> 0, 38);
    central.writeUInt32LE(this.#offset, 42);
    this.#central.push(central, nameBuf);

    writeAll(this.#fd, local);
    writeAll(this.#fd, nameBuf);
    writeAll(this.#fd, body);
    this.#offset += 30 + nameBuf.length + body.length;
    this.#count++;
  }

  finish(): void {
    const cd = Buffer.concat(this.#central);
    if (this.#offset + cd.length > MAX_U32) throw new ZipFormatError('too-large', 'capsule exceeds 4 GiB');
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(EOCD_SIG, 0);
    eocd.writeUInt16LE(this.#count, 8);
    eocd.writeUInt16LE(this.#count, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(this.#offset, 16);
    writeAll(this.#fd, cd);
    writeAll(this.#fd, eocd);
    fs.fsyncSync(this.#fd);
    fs.closeSync(this.#fd);
    this.#done = true;
  }

  abort(): void {
    if (this.#done) return;
    this.#done = true;
    try {
      fs.closeSync(this.#fd);
    } catch {
      // already closed
    }
    fs.rmSync(this.#path, { force: true });
  }
}

export interface ZipEntry {
  name: string;
  method: number;
  crc32: number;
  compressedSize: number;
  size: number;
  localOffset: number;
  dataOffset: number;
  isDirectory: boolean;
  executable: boolean;
}

export class ZipReader {
  #fd: number;
  #size: number;
  #limits: ZipLimits;
  #byName = new Map<string, ZipEntry>();
  entries: ZipEntry[] = [];

  private constructor(filePath: string, limits: ZipLimits) {
    this.#fd = fs.openSync(filePath, 'r');
    this.#size = fs.fstatSync(this.#fd).size;
    this.#limits = limits;
  }

  static open(filePath: string, limits: ZipLimits = DEFAULT_ZIP_LIMITS): ZipReader {
    const r = new ZipReader(filePath, limits);
    try {
      r.#parse();
    } catch (err) {
      r.close();
      throw err;
    }
    return r;
  }

  #read(pos: number, len: number): Buffer {
    if (pos < 0 || len < 0 || pos + len > this.#size) throw new ZipFormatError('corrupted', 'archive is truncated');
    const buf = Buffer.alloc(len);
    readExact(this.#fd, buf, len, pos);
    return buf;
  }

  #parse(): void {
    if (this.#size < 22) throw new ZipFormatError('corrupted', 'not a capsule archive');
    const tailLen = Math.min(this.#size, 22 + MAX_U16);
    const tailStart = this.#size - tailLen;
    const tail = this.#read(tailStart, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD_SIG) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipFormatError('corrupted', 'not a capsule archive (no end-of-archive record)');
    const disk = tail.readUInt16LE(eocd + 4);
    const cdDisk = tail.readUInt16LE(eocd + 6);
    const countOnDisk = tail.readUInt16LE(eocd + 8);
    const count = tail.readUInt16LE(eocd + 10);
    const cdSize = tail.readUInt32LE(eocd + 12);
    const cdOffset = tail.readUInt32LE(eocd + 16);
    const commentLen = tail.readUInt16LE(eocd + 20);
    if (disk !== 0 || cdDisk !== 0 || countOnDisk !== count) throw new ZipFormatError('unsupported', 'multi-part archives are not supported');
    if (count === MAX_U16 || cdSize === MAX_U32 || cdOffset === MAX_U32) throw new ZipFormatError('unsupported', 'ZIP64 archives are not supported');
    if (eocd + 22 + commentLen !== tail.length) throw new ZipFormatError('corrupted', 'unexpected data after the end of the archive');
    if (cdOffset + cdSize !== tailStart + eocd) throw new ZipFormatError('corrupted', 'central directory is out of place');
    if (count > this.#limits.maxEntries) throw new ZipFormatError('too-large', `archive has ${count} entries; the limit is ${this.#limits.maxEntries}`);

    const cd = this.#read(cdOffset, cdSize);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let p = 0;
    let total = 0;
    for (let i = 0; i < count; i++) {
      if (p + 46 > cd.length || cd.readUInt32LE(p) !== CENTRAL_SIG) throw new ZipFormatError('corrupted', 'central directory is damaged');
      const madeBy = cd.readUInt16LE(p + 4);
      const flags = cd.readUInt16LE(p + 8);
      const method = cd.readUInt16LE(p + 10);
      const crc = cd.readUInt32LE(p + 16);
      const csize = cd.readUInt32LE(p + 20);
      const size = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const entryCommentLen = cd.readUInt16LE(p + 32);
      const diskStart = cd.readUInt16LE(p + 34);
      const external = cd.readUInt32LE(p + 38);
      const localOffset = cd.readUInt32LE(p + 42);
      if (p + 46 + nameLen + extraLen + entryCommentLen > cd.length) throw new ZipFormatError('corrupted', 'central directory is damaged');
      let name: string;
      try {
        name = decoder.decode(cd.subarray(p + 46, p + 46 + nameLen));
      } catch {
        throw new ZipFormatError('unsafe', 'an entry name is not valid UTF-8');
      }
      p += 46 + nameLen + extraLen + entryCommentLen;

      if (flags & 0x41) throw new ZipFormatError('unsupported', `encrypted ZIP entries are not supported (${name})`);
      if (method !== 0 && method !== 8) throw new ZipFormatError('unsupported', `unsupported compression method ${method} (${name})`);
      if (diskStart !== 0) throw new ZipFormatError('unsupported', 'multi-part archives are not supported');
      if (csize === MAX_U32 || size === MAX_U32 || localOffset === MAX_U32) throw new ZipFormatError('unsupported', 'ZIP64 entries are not supported');

      const host = madeBy >> 8;
      const unixMode = host === 3 ? external >>> 16 : 0;
      const type = unixMode & S_IFMT;
      if (type === S_IFLNK) throw new ZipFormatError('unsafe', `symbolic links are not allowed in a capsule (${name})`);
      if (type !== 0 && type !== S_IFREG && type !== S_IFDIR) throw new ZipFormatError('unsafe', `special files are not allowed in a capsule (${name})`);
      const isDirectory = name.endsWith('/') || type === S_IFDIR || (host === 0 && (external & 0x10) !== 0);

      if (method === 0 && csize !== size) throw new ZipFormatError('corrupted', `size mismatch in ${name}`);
      if (size > 0 && csize === 0) throw new ZipFormatError('corrupted', `size mismatch in ${name}`);
      if (size > this.#limits.maxEntrySize) throw new ZipFormatError('too-large', `${name} expands to ${size} bytes, over the per-file limit`);
      if (size > 1024 * 1024 && size / csize > this.#limits.maxRatio) {
        throw new ZipFormatError('too-large', `${name} has an implausible compression ratio`);
      }
      total += size;
      if (total > this.#limits.maxTotalSize) throw new ZipFormatError('too-large', 'archive expands beyond the size limit');
      if (this.#byName.has(name)) throw new ZipFormatError('unsafe', `duplicate entry ${name}`);

      const entry: ZipEntry = {
        name,
        method,
        crc32: crc,
        compressedSize: csize,
        size,
        localOffset,
        dataOffset: 0,
        isDirectory,
        executable: (unixMode & 0o111) !== 0,
      };
      this.entries.push(entry);
      this.#byName.set(name, entry);
    }
    if (p !== cd.length) throw new ZipFormatError('corrupted', 'central directory has trailing data');

    // Every entry's local header and data must fit between its offset and the
    // next entry, so entries can't overlap or point into the directory.
    const sorted = [...this.entries].sort((a, b) => a.localOffset - b.localOffset);
    for (let i = 0; i < sorted.length; i++) {
      const e = sorted[i];
      const header = this.#read(e.localOffset, 30);
      if (header.readUInt32LE(0) !== LOCAL_SIG) throw new ZipFormatError('corrupted', `damaged entry header for ${e.name}`);
      const ln = header.readUInt16LE(26);
      const lx = header.readUInt16LE(28);
      const localName = this.#read(e.localOffset + 30, ln);
      if (!localName.equals(Buffer.from(e.name, 'utf8'))) throw new ZipFormatError('corrupted', `entry names disagree for ${e.name}`);
      e.dataOffset = e.localOffset + 30 + ln + lx;
      const limit = i + 1 < sorted.length ? sorted[i + 1].localOffset : cdOffset;
      if (e.dataOffset + e.compressedSize > limit) throw new ZipFormatError('corrupted', `overlapping or out-of-range entry ${e.name}`);
    }
  }

  get(name: string): ZipEntry | undefined {
    return this.#byName.get(name);
  }

  read(entry: ZipEntry): Buffer {
    const raw = this.#read(entry.dataOffset, entry.compressedSize);
    let out: Buffer;
    if (entry.method === 0) out = raw;
    else {
      try {
        out = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(entry.size, 1) });
      } catch {
        throw new ZipFormatError('corrupted', `damaged or oversized data in ${entry.name}`);
      }
    }
    if (out.length !== entry.size) throw new ZipFormatError('corrupted', `size mismatch in ${entry.name}`);
    if (zlib.crc32(out) !== entry.crc32) throw new ZipFormatError('corrupted', `checksum mismatch in ${entry.name}`);
    return out;
  }

  close(): void {
    try {
      fs.closeSync(this.#fd);
    } catch {
      // already closed
    }
  }
}
